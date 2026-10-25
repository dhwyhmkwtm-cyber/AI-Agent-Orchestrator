import type { Attempt, Project, RoleDefinition, Task } from './types.ts';

// エージェントに渡すプロンプトと出力スキーマ。スキーマは厳格(全項目必須・追加項目なし)にしておく。

const str = { type: 'string' } as const;
const strList = { type: 'array', items: str } as const;

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rationale', 'tasks'],
  properties: {
    rationale: str,
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title', 'description', 'role', 'dependsOn', 'reviewers', 'approval'],
        properties: {
          key: str,
          title: str,
          description: str,
          role: str,
          dependsOn: strList,
          reviewers: strList,
          approval: {
            type: 'object',
            additionalProperties: false,
            required: ['required', 'category', 'reason'],
            properties: {
              required: { type: 'boolean' },
              category: { type: 'string', enum: ['decision', 'publish', 'cost'] },
              reason: str,
            },
          },
        },
      },
    },
  },
};

export const EXECUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'rationale', 'deliverables', 'openQuestions'],
  properties: {
    summary: str,
    rationale: str,
    deliverables: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'description'],
        properties: { path: str, description: str },
      },
    },
    openQuestions: strList,
  },
};

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'score', 'issues', 'rootCause', 'suggestions', 'rationale'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    issues: strList,
    rootCause: str,
    suggestions: strList,
    rationale: str,
  },
};

const bullets = (items: string[]) => items.map((c) => `- ${c}`).join('\n');

export function roleSystemPrompt(role: RoleDefinition): string {
  return [
    `あなたはAIチームの「${role.name}」(${role.id})です。`,
    `使命: ${role.mission}`,
    '判断基準:',
    bullets(role.criteria),
    '',
    'チームのルール:',
    '- 作業は現在のディレクトリ(プロジェクトのワークスペース)の中だけで行う。',
    '- 外部への公開・送信、費用が発生する操作は、承認されるまで実行しない。',
    '- 判断には理由を添える。わからないことは推測で埋めず、未解決の問いとして挙げる。',
    '- 回答は日本語で書く。',
  ].join('\n');
}

export function planPrompt(project: Project, team: RoleDefinition[], error?: string): string {
  return [
    `# プロジェクト: ${project.name}`,
    `目的: ${project.goal}`,
    '',
    '## 利用可能な役割',
    team.map((r) => `- ${r.id}: ${r.name} — ${r.mission}`).join('\n'),
    '',
    '## 指示',
    '目的を達成するための作業計画を立ててください。',
    '- tasks[].role と reviewers には上の役割IDだけを使う。reviewers に担当自身を含めない。',
    '- dependsOn には先に完了している必要があるタスクの key を書く。',
    '- 外部公開・費用が発生する操作・重要な意思決定を含むタスクは approval.required を true にする。',
    '- 成果物は各タスクでファイルとしてワークスペースに保存させる。',
    project.planFeedback ? `\n## 前回の計画に対する人間のフィードバック\n${project.planFeedback}` : '',
    error ? `\n## 前回の出力の問題(修正してください)\n${error}` : '',
  ].join('\n');
}

function attemptDigest(a: Attempt): string {
  return [
    `要約: ${a.summary}`,
    `判断理由: ${a.rationale}`,
    a.deliverables.length ? `成果物:\n${a.deliverables.map((d) => `- ${d.path}: ${d.description}`).join('\n')}` : '',
  ].join('\n');
}

export function executionPrompt(project: Project, task: Task, deps: Task[]): string {
  const last = task.attempts.at(-1);
  const sections = [
    `# プロジェクト: ${project.name}`,
    `目的: ${project.goal}`,
    '',
    `## あなたのタスク: ${task.title}`,
    `タスクキー: ${task.key}`,
    task.description,
  ];
  for (const dep of deps) {
    const done = dep.attempts.at(-1);
    if (done) sections.push('', `## 前工程「${dep.title}」(${dep.role})の成果`, attemptDigest(done));
  }
  if (last) {
    sections.push(
      '',
      '## 前回の試行とレビュー結果',
      last.error ? `実行エラー: ${last.error}` : attemptDigest(last),
      ...last.reviews.map(
        (r) =>
          `### ${r.reviewer} の指摘 (${r.verdict}, ${r.score}点)\n問題:\n${bullets(r.issues)}\n原因: ${r.rootCause}\n修正案:\n${bullets(r.suggestions)}`,
      ),
      '',
      '指摘の根本原因を分析し、成果物を修正してください。rationale には何をなぜ直したかを書いてください。',
    );
  }
  if (task.humanFeedback) sections.push('', '## 人間からのフィードバック(最優先)', task.humanFeedback);
  sections.push('', '成果物はファイルとして保存し、deliverables にパスを列挙してください。');
  return sections.join('\n');
}

export function reviewPrompt(project: Project, task: Task, executor: RoleDefinition, attempt: Attempt): string {
  return [
    `# プロジェクト: ${project.name}`,
    `目的: ${project.goal}`,
    '',
    `## 検証対象タスク: ${task.title}`,
    `担当: ${executor.id}(${executor.name})`,
    `試行: ${attempt.n}`,
    task.description,
    '',
    '## 担当者の判断基準',
    bullets(executor.criteria),
    '',
    '## 提出物',
    attemptDigest(attempt),
    '',
    '## 指示',
    '提出物(ファイルは実際に開いて確認する)が、タスクの要件・担当者の判断基準・あなた自身の判断基準を満たすか検証してください。',
    '- 基準を満たさない項目が1つでもあれば verdict は fail。',
    '- 問題がある場合、rootCause に根本原因を、suggestions に具体的な修正方法を書く。',
    '- ファイルは変更しない。',
  ].join('\n');
}
