// 実際のプロバイダで小さなプロジェクトを1つ流し、結果を表示する動作確認用スクリプト。
// 計画と「意思決定」の承認ゲートは自動承認し、外部公開・費用・危険なツール操作・品質未達は自動で却下する。
//
//   npx tsx scripts/smoke.ts [予算USD]

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Approvals } from '../src/core/approvals.ts';
import { Orchestrator } from '../src/core/orchestrator.ts';
import { Store } from '../src/core/store.ts';
import { createRegistryFromEnv } from '../src/providers/registry.ts';
import { DEFAULT_ROLES } from '../src/roles/catalog.ts';

const budgetUsd = Number(process.argv[2] ?? 3);
const base = mkdtempSync(join(tmpdir(), 'orchestrator-smoke-'));
const store = new Store(join(base, 'data'));
const approvals = new Approvals(store);
const { registry, override } = createRegistryFromEnv();
const orchestrator = new Orchestrator({
  store,
  approvals,
  providers: registry,
  roles: DEFAULT_ROLES,
  workspaceRoot: join(base, 'workspaces'),
  providerOverride: override,
  maxAttempts: 2,
});

store.on('event', (e) => {
  const who = e.agent ?? '';
  console.log(`${e.ts.slice(11, 19)} ${e.kind.padEnd(8)} ${String(who).padEnd(15)} ${e.message}`);
});

// 承認依頼を出した処理が待ち状態に入ってから決裁するため、次のイベントループで処理する
store.on('change', () => setImmediate(decidePending));
function decidePending(): void {
  for (const a of approvals.pending()) {
    const approve = a.kind === 'plan' || (a.kind === 'task_gate' && a.category === 'decision');
    console.log(`\n>>> 自動${approve ? '承認' : '却下'}: [${a.kind}] ${a.title}\n${a.detail}\n`);
    approvals.decide(a.id, approve, approve ? undefined : '動作確認のため自動で却下しました');
  }
}

const project = orchestrator.createProject({
  name: '動作確認: 競合比較メモ',
  goal:
    '日本のコーヒー豆の定期便(サブスク)サービスを2〜3社調べ、価格・頻度・特徴を比較した1ページのMarkdownメモ(comparison.md)を作る。' +
    'Webサイトの制作や公開は行わない。',
  team: ['researcher'],
  budgetUsd,
});

const finished = ['done', 'failed', 'paused'];
const timer = setInterval(() => {
  if (!finished.includes(project.status)) return;
  clearInterval(timer);
  setTimeout(() => {
    store.flush();
    console.log(`\n結果: ${project.status} / 費用 $${project.spentUsd.toFixed(3)} / 予算 $${project.budgetUsd}`);
    console.log(`ワークスペース: ${join(base, 'workspaces', project.id)}`);
    process.exit(project.status === 'done' ? 0 : 1);
  }, 500);
}, 500);
