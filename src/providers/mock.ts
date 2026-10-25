import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentProvider, AgentRunRequest, AgentRunResult } from './types.ts';

export type MockHandler = (req: AgentRunRequest) => unknown | Promise<unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * APIを呼ばずに動くプロバイダ。テストと、APIキーなしでダッシュボードを試すデモに使う。
 * handler を渡せば応答を自由に差し替えられる。
 */
export class MockProvider implements AgentProvider {
  readonly id = 'mock';

  constructor(
    private readonly handler: MockHandler = demoHandler,
    private readonly delayMs = 0,
  ) {}

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    req.onProgress(`(mock) ${req.role.name} が ${req.purpose} を開始`);
    if (this.delayMs) await sleep(this.delayMs);
    return { output: await this.handler(req), costUsd: 0.01 };
  }
}

/** デモ用の筋書き: 計画 → 実行 → レビュー(文章制作だけ初回は差し戻し)。 */
export function demoHandler(req: AgentRunRequest): unknown {
  if (req.purpose === 'plan') {
    const available = new Set([...req.prompt.matchAll(/^- (\w+):/gm)].map((m) => m[1]));
    const steps = [
      { key: 'research', role: 'researcher', title: '市場の一次情報を収集', deps: [] as string[] },
      { key: 'market', role: 'market_analyst', title: '市場規模と競合を分析', deps: ['research'] },
      { key: 'concept', role: 'product_planner', title: '商品コンセプトを企画', deps: ['market'] },
      { key: 'copy', role: 'copywriter', title: 'LPのコピーを制作', deps: ['concept'] },
      { key: 'site', role: 'web_developer', title: 'LPを実装して公開準備', deps: ['copy'] },
    ].filter((s) => available.has(s.role));
    const keys = new Set(steps.map((s) => s.key));
    return {
      rationale: '調査→分析→企画→制作の順に、前工程の成果を根拠に次工程を進める。公開を伴うLPは承認制にする。',
      tasks: steps.map((s) => ({
        key: s.key,
        title: s.title,
        description: `${s.title}。成果物を ${s.key}.md に保存する。`,
        role: s.role,
        dependsOn: s.deps.filter((d) => keys.has(d)),
        reviewers: ['qa_reviewer'],
        approval:
          s.key === 'site'
            ? { required: true, category: 'publish', reason: 'Webサイトを外部公開するため' }
            : { required: false, category: 'decision', reason: '' },
      })),
    };
  }

  if (req.purpose === 'execute') {
    const key = /タスクキー: (\S+)/.exec(req.prompt)?.[1] ?? 'output';
    const path = `${key}.md`;
    mkdirSync(dirname(join(req.cwd, path)), { recursive: true });
    writeFileSync(join(req.cwd, path), `# ${key}\n\n(mock) ${req.role.name} の成果物\n`);
    return {
      summary: `(mock) ${req.role.name} が作業を完了しました。`,
      rationale: '判断基準の各項目を満たすように作成した。',
      deliverables: [{ path, description: `${req.role.name} の成果物` }],
      openQuestions: [],
    };
  }

  const firstTry = /試行: 1\b/.test(req.prompt);
  const fail = firstTry && /担当: copywriter/.test(req.prompt);
  return {
    verdict: fail ? 'fail' : 'pass',
    score: fail ? 55 : 85,
    issues: fail ? ['ターゲット読者が不明確で、行動を促すメッセージが弱い'] : [],
    rootCause: fail ? '企画書のペルソナ定義を参照せずに書かれている' : '',
    suggestions: fail ? ['企画書のペルソナに合わせて見出しとCTAを書き直す'] : [],
    rationale: fail ? '判断基準「行動を促す明確なメッセージ」を満たしていない。' : '判断基準をすべて満たしている。',
  };
}
