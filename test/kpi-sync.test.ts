import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Approvals } from '../src/core/approvals.ts';
import { KpiSync, extractValue, parseNumber, pickCsvCell } from '../src/core/kpi-sync.ts';
import { Orchestrator, validateKpiSource } from '../src/core/orchestrator.ts';
import { Store } from '../src/core/store.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/registry.ts';
import { DEFAULT_ROLES } from '../src/roles/catalog.ts';
import { createDashboardServer } from '../src/server/http.ts';

function setup(fetchText: (url: string) => Promise<string> = async () => '0') {
  const store = new Store();
  const approvals = new Approvals(store);
  const providers = new ProviderRegistry().register(new MockProvider());
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'orch-'));
  const orchestrator = new Orchestrator({ store, approvals, providers, roles: DEFAULT_ROLES, workspaceRoot, providerOverride: 'mock' });
  const sync = new KpiSync(store, orchestrator, fetchText);
  return { store, approvals, orchestrator, sync, workspaceRoot };
}

const source = (over: Record<string, unknown> = {}) =>
  ({ type: 'url', url: 'https://example.com/kpi.json', format: 'json', path: 'data.total', intervalMinutes: 60, ...over }) as never;

test('いろいろな書き方の数値を読み取る', () => {
  assert.equal(parseNumber('¥1,234,567'), 1234567);
  assert.equal(parseNumber(' 45.6% '), 45.6);
  assert.equal(parseNumber('-12 人'), -12);
  assert.equal(parseNumber(42), 42);
  assert.throws(() => parseNumber('なし'), /数値が見つかりません/);
});

test('JSON のパス・CSV のセル・テキストから値を取り出す', () => {
  assert.equal(extractValue('{"data":{"items":[{"total":"1,200"}]}}', { format: 'json', path: 'data.items.0.total' }), 1200);
  assert.throws(() => extractValue('{"data":{}}', { format: 'json', path: 'data.total' }), /見つかりません/);
  const csv = '項目,値\n売上,"1,500,000"\n会員,"84"\n';
  assert.equal(pickCsvCell(csv, 'B2'), '1,500,000');
  assert.equal(extractValue(csv, { format: 'csv', path: 'b3' }), 84);
  assert.throws(() => pickCsvCell(csv, 'Z9'), /見つかりません/);
  assert.equal(extractValue('現在の会員数: 312 人', { format: 'text', path: '' }), 312);
});

test('取り込み元の設定は検証される', () => {
  assert.equal(validateKpiSource(source()).intervalMinutes, 60);
  assert.throws(() => validateKpiSource(source({ url: 'file:///etc/passwd' })), /http\(s\)/);
  assert.throws(() => validateKpiSource(source({ url: 'not a url' })), /正しくありません/);
  assert.throws(() => validateKpiSource(source({ format: 'csv', path: 'total' })), /B2/);
  assert.throws(() => validateKpiSource(source({ path: '' })), /パス/);
  assert.throws(() => validateKpiSource(source({ intervalMinutes: 1 })), /5分/);
});

test('間隔が過ぎたKPIだけを取り込み、失敗は記録して前の値を残す', async () => {
  let body = '{"data":{"total":1500}}';
  let calls = 0;
  const { orchestrator, sync } = setup(async () => {
    calls++;
    return body;
  });
  const biz = orchestrator.createBusiness({ name: 'b', kpis: [{ name: '売上', source: source() }, { name: '手入力', current: 5 }] });
  const kpi = biz.kpis[0];

  await sync.syncDue();
  assert.equal(kpi.current, 1500);
  assert.deepEqual([kpi.sync?.ok, kpi.sync?.via], [true, 'url']);
  assert.equal(biz.kpis[1].current, 5, '手入力のKPIは触らない');

  await sync.syncDue();
  assert.equal(calls, 1, '間隔が過ぎるまでは取りに行かない');

  body = 'エラー';
  await sync.syncDue(Date.now() + 61 * 60_000);
  assert.equal(calls, 2);
  assert.equal(kpi.current, 1500, '失敗しても前の値は残す');
  assert.equal(kpi.sync?.ok, false);
  assert.match(kpi.sync?.error ?? '', /JSON/);

  orchestrator.updateBusiness(biz.id, { kpis: [{ id: kpi.id, name: '売上', source: source({ path: 'data.other' }) }, { id: biz.kpis[1].id, name: '手入力' }] });
  assert.equal(biz.kpis[0].sync, undefined, '取り込み元を変えたら前回の結果は消える');
});

test('外部サービスからの値の受け口は専用トークンで認証する', async () => {
  const { store, approvals, orchestrator, sync, workspaceRoot } = setup();
  const biz = orchestrator.createBusiness({ name: 'b', kpis: [{ name: '月間売上', unit: '円' }] });
  const server = createDashboardServer({
    store, approvals, orchestrator, kpiSync: sync, providerIds: ['mock'],
    publicDir: workspaceRoot, workspaceRoot, token: 'dashboard-token', ingestToken: 'ingest-token',
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ingest/kpi`;
  const post = (token: string, body: unknown) =>
    fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('dashboard-token', { businessId: biz.id, kpi: '月間売上', value: 1 })).status, 401, 'ダッシュボードのトークンでは送れない');
    assert.equal((await post('wrong', { businessId: biz.id, kpi: '月間売上', value: 1 })).status, 401);
    assert.equal((await post('ingest-token', { businessId: biz.id, kpi: '月間売上', value: 'abc' })).status, 400);
    assert.equal((await post('ingest-token', { businessId: biz.id, kpi: '存在しない', value: 1 })).status, 404);
    const ok = await post('ingest-token', { businessId: biz.id, kpi: '月間売上', value: '¥2,450,000' });
    assert.equal(ok.status, 200);
    assert.equal(biz.kpis[0].current, 2450000);
    assert.equal(biz.kpis[0].sync?.via, 'webhook');
  } finally {
    server.close();
  }
});
