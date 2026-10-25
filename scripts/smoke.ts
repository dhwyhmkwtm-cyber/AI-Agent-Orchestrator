// 実際のプロバイダで小さなプロジェクトを1つ流し、結果を表示する動作確認用スクリプト。
// 計画と「意思決定」の承認ゲートは自動承認し、外部公開・費用・危険なツール操作・品質未達は自動で却下する。
//
//   npm run smoke -- <予算USD> [copy|research]   (実際にAPI費用がかかるため、予算の指定は必須)
//
//   copy     … 与えた商品情報だけでLPのコピーを作る(Webアクセス不要。既定)
//   research … Webで競合を調べて比較メモを作る(接続先が制限された環境では完了できない)

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Approvals } from '../src/core/approvals.ts';
import { Orchestrator } from '../src/core/orchestrator.ts';
import { Store } from '../src/core/store.ts';
import { createRegistryFromEnv } from '../src/providers/registry.ts';
import { DEFAULT_ROLES } from '../src/roles/catalog.ts';

const budgetUsd = Number(process.argv[2]);
if (!(budgetUsd > 0)) {
  console.error('予算(USD)を指定してください。例: npm run smoke -- 1');
  process.exit(2);
}
const SCENARIOS = {
  copy: {
    name: '動作確認: LPコピー制作',
    goal:
      '次の商品情報だけを使って、LP用のコピー(キャッチコピー、リード文、特徴3つ、よくある質問3つ、申し込みボタンの文言)を copy.md に作る。' +
      'Web検索や外部サイトの参照、Webサイトの制作や公開は行わない。\n' +
      '商品情報: 「朝5分ベーカリー」— 冷凍の焼きたて風パンの定期便。対象は共働きの30代。' +
      '1回6個入り・月2回お届け・税込2,980円/回・送料無料。オーブントースターで5分温めるだけ。' +
      '国産小麦使用、保存料不使用。いつでもスキップ・解約可(次回発送の5日前まで)。',
    team: ['copywriter'],
  },
  research: {
    name: '動作確認: 競合比較メモ',
    goal:
      '日本のコーヒー豆の定期便(サブスク)サービスを2〜3社調べ、価格・頻度・特徴を比較した1ページのMarkdownメモ(comparison.md)を作る。' +
      'Webサイトの制作や公開は行わない。',
    team: ['researcher'],
  },
} as const;
const scenarioName = (process.argv[3] ?? 'copy') as keyof typeof SCENARIOS;
const scenario = SCENARIOS[scenarioName];
if (!scenario) {
  console.error(`題材は ${Object.keys(SCENARIOS).join(' / ')} のどれかを指定してください`);
  process.exit(2);
}

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
  name: scenario.name,
  goal: scenario.goal,
  team: [...scenario.team],
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
