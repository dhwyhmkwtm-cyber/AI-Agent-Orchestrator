import type { Orchestrator } from './orchestrator.ts';
import type { Store } from './store.ts';
import type { KpiSource } from './types.ts';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1024 * 1024;

/** 「¥1,234,567」「45.6%」「 12 人」などから数値を取り出す。 */
export function parseNumber(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const match = String(raw ?? '').replace(/[,，\s]/g, '').match(/-?\d+(\.\d+)?/);
  if (!match) throw new Error(`数値が見つかりません: ${String(raw).slice(0, 40)}`);
  return Number(match[0]);
}

/** JSON から "data.items.0.total" のようなパスで値を取り出す。 */
export function pickJson(body: string, path: string): unknown {
  let value: unknown = JSON.parse(body);
  for (const key of path.split('.').filter(Boolean)) {
    if (value === null || typeof value !== 'object' || !(key in value)) throw new Error(`パス ${path} が見つかりません`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** 簡易CSVパーサ(ダブルクォート対応)。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** CSV から "B2" のようなセル番地で値を取り出す。 */
export function pickCsvCell(body: string, cell: string): string {
  const m = /^([A-Z]+)(\d+)$/i.exec(cell.trim());
  if (!m) throw new Error(`セル番地は B2 のように指定してください: ${cell}`);
  const col = [...m[1].toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const value = parseCsv(body)[Number(m[2]) - 1]?.[col];
  if (value === undefined) throw new Error(`セル ${cell} が見つかりません`);
  return value;
}

export function extractValue(body: string, source: Pick<KpiSource, 'format' | 'path'>): number {
  if (source.format === 'json') return parseNumber(pickJson(body, source.path));
  if (source.format === 'csv') return parseNumber(pickCsvCell(body, source.path));
  return parseNumber(body);
}

export type FetchText = (url: string) => Promise<string>;

/** タイムアウトとサイズ上限つきで本文を取得する。 */
export const fetchText: FetchText = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json, text/csv, text/plain, */*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) throw new Error('応答が大きすぎます');
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('応答が大きすぎます');
  return text;
};

/**
 * URL から取得する設定のKPIを、設定した間隔ごとに取り込む。
 * 外部サービスから送ってもらう方式(受け口)は HTTP サーバー側で受け、Orchestrator.setKpiValue を呼ぶ。
 */
export class KpiSync {
  private timer?: NodeJS.Timeout;
  private running = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly orchestrator: Orchestrator,
    private readonly fetch: FetchText = fetchText,
  ) {}

  start(checkEveryMs = 60_000): void {
    this.timer = setInterval(() => void this.syncDue(), checkEveryMs);
    void this.syncDue();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** 前回の取得から間隔が過ぎたKPIを取り込む。 */
  async syncDue(at = Date.now()): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const b of this.store.state.businesses) {
      if (b.archivedAt) continue;
      for (const k of b.kpis) {
        if (k.source?.type !== 'url') continue;
        const last = k.sync ? Date.parse(k.sync.at) : 0;
        if (at - last >= k.source.intervalMinutes * 60_000) jobs.push(this.syncOne(b.id, k.id));
      }
    }
    await Promise.all(jobs);
  }

  async syncOne(businessId: string, kpiId: string): Promise<void> {
    const key = `${businessId}/${kpiId}`;
    if (this.running.has(key)) return;
    const kpi = this.store.state.businesses.find((b) => b.id === businessId)?.kpis.find((k) => k.id === kpiId);
    if (kpi?.source?.type !== 'url') throw new Error('このKPIはURLから取得する設定ではありません');
    this.running.add(key);
    try {
      const value = extractValue(await this.fetch(kpi.source.url), kpi.source);
      this.orchestrator.setKpiValue(businessId, kpiId, value, 'url');
    } catch (err) {
      this.orchestrator.recordKpiSyncError(businessId, kpiId, err instanceof Error ? err.message : String(err));
    } finally {
      this.running.delete(key);
    }
  }
}
