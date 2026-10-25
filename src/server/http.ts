import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { Approvals } from '../core/approvals.ts';
import type { BusinessInput, Orchestrator, RoleInput } from '../core/orchestrator.ts';
import { EFFORT_CHOICES, MODEL_CHOICES, TOOL_CHOICES } from '../roles/catalog.ts';
import { DEFAULT_MODEL } from '../providers/claude-code.ts';
import { parseNumber, type KpiSync } from '../core/kpi-sync.ts';
import { monthKey, type Store } from '../core/store.ts';
import type { KpiSource } from '../core/types.ts';

export interface ServerOptions {
  store: Store;
  approvals: Approvals;
  orchestrator: Orchestrator;
  /** 役割の担当に選べるAIサービスのID。 */
  providerIds: string[];
  publicDir: string;
  workspaceRoot: string;
  /** ダッシュボードのログイントークン。 */
  token: string;
  /** 外部サービスからKPIの値を受け取るときのトークン。 */
  ingestToken: string;
  kpiSync: KpiSync;
}

const COOKIE = 'orchestrator_token';
const MAX_BODY = 64 * 1024;
const MAX_FILE_VIEW = 512 * 1024;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

/** 処理を実行し、失敗を HTTP エラーにする(見つからない対象は 404)。 */
function attempt<T>(fn: () => T, status = 400): T {
  try {
    return fn();
  } catch (err) {
    const message = (err as Error).message;
    throw new HttpError(/not found/.test(message) ? 404 : status, message);
  }
}

/** 「既定」の選択肢に、実際に使われるモデル名を添える。 */
function modelChoices(): typeof MODEL_CHOICES {
  const id = process.env.CLAUDE_MODEL || DEFAULT_MODEL;
  const name = MODEL_CHOICES.find((m) => m.id === id)?.label.replace(/\(.*\)$/, '') ?? id;
  return MODEL_CHOICES.map((m) => (m.id === '' ? { ...m, label: `既定(${name})` } : m));
}

function roleInput(body: Record<string, unknown>): RoleInput {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    name: String(body.name ?? ''),
    mission: String(body.mission ?? ''),
    criteria: list(body.criteria),
    tools: list(body.tools),
    provider: String(body.provider ?? ''),
    model: body.model ? String(body.model) : undefined,
    effort: body.effort ? (String(body.effort) as RoleInput['effort']) : undefined,
  };
}

/** リクエストの本文から、指定された項目だけを事業の入力にする。 */
function businessInput(body: Record<string, unknown>): Partial<BusinessInput> {
  const input: Partial<BusinessInput> = {};
  if (body.name !== undefined) input.name = String(body.name);
  if (body.description !== undefined) input.description = String(body.description);
  if (Array.isArray(body.team)) input.team = body.team.map(String);
  if (body.monthlyBudgetUsd !== undefined) {
    input.monthlyBudgetUsd = body.monthlyBudgetUsd === null || body.monthlyBudgetUsd === '' ? null : Number(body.monthlyBudgetUsd);
  }
  if (Array.isArray(body.kpis)) {
    const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
    input.kpis = body.kpis.map((raw) => {
      const k = (raw ?? {}) as Record<string, unknown>;
      return {
        id: k.id ? String(k.id) : undefined,
        name: String(k.name ?? ''),
        unit: k.unit === undefined ? undefined : String(k.unit),
        target: num(k.target),
        current: num(k.current),
        source: k.source && typeof k.source === 'object' ? (k.source as KpiSource) : null,
      };
    });
  }
  return input;
}

/** ワークスペース内のパスだけを解決する(シンボリックリンクでの脱出も防ぐ)。 */
function resolveInside(root: string, rel: string): string {
  const base = realpathSync(root);
  const target = resolve(base, rel);
  if (!existsSync(target)) throw new HttpError(404, 'not found');
  const real = realpathSync(target);
  if (real !== base && !real.startsWith(base + sep)) throw new HttpError(403, 'outside workspace');
  return real;
}

function listFiles(root: string, dir = root, out: Array<{ path: string; size: number }> = []): typeof out {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(root, full, out);
    else if (entry.isFile()) out.push({ path: relative(root, full), size: statSync(full).size });
    if (out.length >= 500) break;
  }
  return out;
}

/**
 * ダッシュボード用のHTTPサーバー。
 * - GET  /login?token=…            トークンをCookieに保存してダッシュボードへ
 * - GET  /api/state                全体の状態
 * - GET  /api/events?projectId=…   作業ログ
 * - GET  /api/stream               状態変化とログのSSE
 * - POST /api/businesses           事業の作成 {name, description?, team?, monthlyBudgetUsd?}
 * - POST /api/businesses/:id       事業の更新(同じ項目+kpis、指定したものだけ)
 * - POST /api/businesses/:id/archive  アーカイブ {archived: boolean}
 * - DELETE /api/businesses/:id     事業の削除(プロジェクトがない場合のみ)
 * - POST /api/businesses/:id/kpis/:kpiId/sync  URLから取得する設定のKPIを今すぐ取り込む
 * - POST /api/ingest/kpi           外部サービスからKPIの値を受け取る {businessId, kpi(IDか名前), value}
 *                                  (Authorization: Bearer <取り込み用トークン>)
 * - POST /api/projects/:id/move    プロジェクトの事業を変更 {businessId: string | null}
 * - POST /api/roles                役割の追加 {name, mission, criteria[], tools[], provider, model?, effort?}
 * - POST /api/roles/:id            役割の更新(同じ項目すべて)
 * - POST /api/roles/:id/reset      標準の役割を初期値に戻す
 * - DELETE /api/roles/:id          追加した役割の削除(どのチームにも入っていない場合のみ)
 * - POST /api/projects             プロジェクト作成 {name, goal, businessId?, team?, budgetUsd?}
 * - POST /api/projects/:id/retry   失敗したプロジェクトの再開
 * - POST /api/approvals/:id        承認・却下 {approve: boolean, comment?}
 * - GET  /api/projects/:id/files[?path=…]  成果物の一覧・内容
 */
export function createDashboardServer(opts: ServerOptions): Server {
  const { store, approvals, orchestrator } = opts;

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const supplied = header ?? readCookie(req, COOKIE);
    return !!supplied && safeEqual(supplied, opts.token);
  };

  const routes = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const { pathname } = url;
    const method = req.method ?? 'GET';

    if (pathname === '/login') {
      const token = url.searchParams.get('token') ?? '';
      if (!safeEqual(token, opts.token)) throw new HttpError(401, 'invalid token');
      res.writeHead(302, {
        'set-cookie': `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
        location: '/',
      });
      res.end();
      return;
    }

    if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);
    // 外部サービス(Zapier・Make・GAS など)からのKPIの値の受け口。専用のトークンで認証する
    if (method === 'POST' && pathname === '/api/ingest/kpi') {
      const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
      if (!safeEqual(supplied, opts.ingestToken)) throw new HttpError(401, 'unauthorized');
      const body = await readJson(req);
      let value: number;
      try {
        value = parseNumber(body.value);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      const kpi = attempt(() => orchestrator.setKpiValue(String(body.businessId ?? ''), String(body.kpi ?? ''), value, 'webhook'));
      return json(res, 200, { ok: true, kpi: { id: kpi.id, name: kpi.name, current: kpi.current } });
    }

    if (!authorized(req)) throw new HttpError(401, 'unauthorized');

    if (method === 'GET' && pathname === '/api/state') {
      return json(res, 200, {
        ...store.state,
        month: monthKey(),
        ingestToken: opts.ingestToken,
        choices: { tools: TOOL_CHOICES, models: modelChoices(), efforts: EFFORT_CHOICES, providers: opts.providerIds },
      });
    }
    if (method === 'GET' && pathname === '/api/events') {
      return json(res, 200, store.recentEvents(url.searchParams.get('projectId') ?? undefined));
    }
    if (method === 'GET' && pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      const onEvent = (e: unknown) => res.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`);
      const onChange = () => res.write('event: change\ndata: {}\n\n');
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      store.on('event', onEvent);
      store.on('change', onChange);
      req.on('close', () => {
        clearInterval(ping);
        store.off('event', onEvent);
        store.off('change', onChange);
      });
      return;
    }
    if (method === 'POST' && pathname === '/api/projects') {
      const body = await readJson(req);
      try {
        const project = orchestrator.createProject({
          name: String(body.name ?? ''),
          goal: String(body.goal ?? ''),
          businessId: body.businessId ? String(body.businessId) : undefined,
          team: Array.isArray(body.team) ? body.team.map(String) : undefined,
          budgetUsd: body.budgetUsd === undefined ? undefined : Number(body.budgetUsd),
        });
        return json(res, 201, project);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }

    if (method === 'POST' && pathname === '/api/businesses') {
      const input = businessInput(await readJson(req));
      try {
        return json(res, 201, orchestrator.createBusiness({ name: '', ...input }));
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }

    let m = /^\/api\/businesses\/([\w-]+)$/.exec(pathname);
    if (method === 'POST' && m) {
      const input = businessInput(await readJson(req));
      return json(res, 200, attempt(() => orchestrator.updateBusiness(m![1], input)));
    }
    if (method === 'DELETE' && m) {
      attempt(() => orchestrator.deleteBusiness(m![1]), 409);
      return json(res, 200, { ok: true });
    }

    m = /^\/api\/businesses\/([\w-]+)\/kpis\/([\w-]+)\/sync$/.exec(pathname);
    if (method === 'POST' && m) {
      try {
        await opts.kpiSync.syncOne(m[1], m[2]);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      return json(res, 200, store.state.businesses.find((b) => b.id === m![1])?.kpis.find((k) => k.id === m![2]) ?? null);
    }

    m = /^\/api\/businesses\/([\w-]+)\/archive$/.exec(pathname);
    if (method === 'POST' && m) {
      const body = await readJson(req);
      if (typeof body.archived !== 'boolean') throw new HttpError(400, 'archived must be boolean');
      return json(res, 200, attempt(() => orchestrator.setBusinessArchived(m![1], body.archived as boolean)));
    }

    if (method === 'POST' && pathname === '/api/roles') {
      const input = roleInput(await readJson(req));
      return json(res, 201, attempt(() => orchestrator.createRole(input)));
    }
    m = /^\/api\/roles\/([\w-]+)$/.exec(pathname);
    if (method === 'POST' && m) {
      const input = roleInput(await readJson(req));
      return json(res, 200, attempt(() => orchestrator.updateRole(m![1], input)));
    }
    if (method === 'DELETE' && m) {
      attempt(() => orchestrator.deleteRole(m![1]), 409);
      return json(res, 200, { ok: true });
    }
    m = /^\/api\/roles\/([\w-]+)\/reset$/.exec(pathname);
    if (method === 'POST' && m) {
      return json(res, 200, attempt(() => orchestrator.resetRole(m![1]), 409));
    }

    m = /^\/api\/projects\/([\w-]+)\/move$/.exec(pathname);
    if (method === 'POST' && m) {
      const body = await readJson(req);
      const businessId = body.businessId === null || body.businessId === '' ? null : String(body.businessId ?? '');
      if (body.businessId === undefined) throw new HttpError(400, 'businessId is required (null for none)');
      return json(res, 200, attempt(() => orchestrator.moveProject(m![1], businessId)));
    }

    m = /^\/api\/projects\/([\w-]+)\/retry$/.exec(pathname);
    if (method === 'POST' && m) {
      try {
        orchestrator.retry(m[1]);
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
      return json(res, 200, { ok: true });
    }

    m = /^\/api\/approvals\/([\w-]+)$/.exec(pathname);
    if (method === 'POST' && m) {
      const body = await readJson(req);
      if (typeof body.approve !== 'boolean') throw new HttpError(400, 'approve must be boolean');
      try {
        return json(res, 200, approvals.decide(m[1], body.approve, body.comment ? String(body.comment) : undefined));
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
    }

    m = /^\/api\/projects\/([\w-]+)\/files$/.exec(pathname);
    if (method === 'GET' && m) {
      if (!store.state.projects.some((p) => p.id === m![1])) throw new HttpError(404, 'project not found');
      const root = join(opts.workspaceRoot, m[1]);
      if (!existsSync(root)) return json(res, 200, []);
      const rel = url.searchParams.get('path');
      if (!rel) return json(res, 200, listFiles(root));
      const file = resolveInside(root, rel);
      const stat = statSync(file);
      if (!stat.isFile()) throw new HttpError(400, 'not a file');
      if (stat.size > MAX_FILE_VIEW) throw new HttpError(413, 'file too large to preview');
      // 成果物はエージェントが書いた信頼できない内容なので、必ずプレーンテキストで返す
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'",
      });
      res.end(readFileSync(file));
      return;
    }

    throw new HttpError(404, 'not found');
  };

  const serveStatic = (res: ServerResponse, pathname: string): void => {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    let file: string;
    try {
      file = resolveInside(opts.publicDir, rel);
    } catch {
      throw new HttpError(404, 'not found');
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'",
      'x-content-type-options': 'nosniff',
    });
    createReadStream(file).pipe(res);
  };

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    routes(req, res, url).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: err instanceof Error ? err.message : 'error' });
      else res.end();
    });
  });
}
