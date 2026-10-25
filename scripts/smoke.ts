// 実際のプロバイダで小さなプロジェクトを1つ流し、結果を表示する動作確認用スクリプト。
// 計画と成果物の承認ゲートは自動承認し、危険なツール操作(デプロイ・外部送信など)・予算超過・品質未達は自動で却下する。
// 成果物の承認ゲートを通しても何かが公開されるわけではない(公開につながる操作はツール承認で止まる)。
//
//   npm run smoke -- <予算USD> [copy|research|launch]   (実際にAPI費用がかかるため、予算の指定は必須)
//
//   copy     … 与えた商品情報だけでLPのコピーを作る(Webアクセス不要。既定)
//   research … Webで競合を調べて比較メモを作る(接続先が制限された環境では完了できない)
//   launch   … 新プランの企画 → LPの文章 → LPのHTML制作まで(Webアクセス不要。実際の業務に近い規模)

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
  launch: {
    name: '新プラン「週末ブランチセット」の企画とLP',
    goal: [
      '冷凍パン定期便「朝5分ベーカリー」の新プラン「週末ブランチセット」を企画し、申し込み用のLPを作る。',
      '成果物: (1) 企画書 plan.md(対象顧客・提供価値・価格の根拠・既存プランとの違い・検証すべき仮説)、',
      '(2) LPの文章 copy.md、(3) LP本体 site/index.html と site/style.css(スマホ・タブレット対応、外部の画像やライブラリは使わない)。',
      'Web検索や外部サイトの参照はしない。LPの公開(デプロイ)や外部への送信は行わない。',
      '',
      '## 与える情報(これ以外の事実は書かない。不明点は仮説として扱う)',
      '- 既存プラン: 1回6個入り・月2回お届け・税込2,980円/回・送料無料。国産小麦使用、保存料不使用。オーブントースターで5分温めるだけ。いつでもスキップ・解約可(次回発送の5日前まで)。',
      '- 会員数: 約1,200人(うち30代の共働き世帯が約6割)。月の解約率は約4%。',
      '- 新プラン案: 土曜の朝に届くセット。パン4種(クロワッサン、デニッシュ、カンパーニュ、シナモンロール)計8個+冷凍スープ2種(各2食)。原価は1セット約1,900円、配送料は1回約700円。',
      '- 会員アンケート(回答312件)の抜粋: 「週末の朝はゆっくり家族で食べたい」41%、「平日用とは違う特別感がほしい」33%、「量が足りない」18%、「価格が高い」12%。',
      '- 価格は税込3,480円〜4,280円の範囲で検討したい。粗利率は40%以上を確保したい。',
    ].join('\n'),
    team: ['product_planner', 'copywriter', 'web_developer'],
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
    const approve = a.kind === 'plan' || a.kind === 'task_gate';
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
