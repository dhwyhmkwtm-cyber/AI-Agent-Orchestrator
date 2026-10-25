import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Approvals } from '../src/core/approvals.ts';
import { Orchestrator, validatePlan } from '../src/core/orchestrator.ts';
import { Store } from '../src/core/store.ts';
import { MockProvider, demoHandler, type MockHandler } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/registry.ts';
import { DEFAULT_ROLES } from '../src/roles/catalog.ts';

function setup(handler: MockHandler = demoHandler, opts: { maxAttempts?: number } = {}) {
  const store = new Store();
  const approvals = new Approvals(store);
  const providers = new ProviderRegistry().register(new MockProvider(handler));
  const orchestrator = new Orchestrator({
    store,
    approvals,
    providers,
    roles: DEFAULT_ROLES,
    workspaceRoot: mkdtempSync(join(tmpdir(), 'orch-')),
    providerOverride: 'mock',
    ...opts,
  });
  return { store, approvals, orchestrator };
}

async function waitFor(cond: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const pendingOf = (approvals: Approvals, kind: string) => approvals.pending().find((a) => a.kind === kind);

test('計画→承認→実行→レビュー差し戻し→修正→公開承認→完了 まで進む', async () => {
  const { store, approvals, orchestrator } = setup();
  const project = orchestrator.createProject({ name: 'LP', goal: '朝食サブスクのLPを作る' });

  await waitFor(() => !!pendingOf(approvals, 'plan'), 'plan approval');
  assert.equal(project.status, 'awaiting_plan_approval');
  const tasks = store.state.tasks.filter((t) => t.projectId === project.id);
  assert.deepEqual(tasks.map((t) => t.key), ['research', 'market', 'concept', 'copy', 'site']);
  assert.ok(tasks.every((t) => t.status === 'pending'), '承認前はどのタスクも始まらない');

  approvals.decide(pendingOf(approvals, 'plan')!.id, true);
  await waitFor(() => !!pendingOf(approvals, 'task_gate'), 'publish gate');

  const copy = tasks.find((t) => t.key === 'copy')!;
  assert.equal(copy.attempts.length, 2, '文章制作は1回差し戻されて修正される');
  assert.equal(copy.attempts[0].reviews[0].verdict, 'fail');
  assert.equal(copy.attempts[1].reviews[0].verdict, 'pass');

  const site = tasks.find((t) => t.key === 'site')!;
  assert.equal(site.status, 'awaiting_approval');
  assert.equal(project.status, 'running');

  approvals.decide(pendingOf(approvals, 'task_gate')!.id, true);
  await waitFor(() => project.status === 'done', 'project done');
  assert.ok(project.spentUsd > 0);
});

test('修正プロンプトにはレビューの原因分析が渡される', async () => {
  const prompts: string[] = [];
  const { approvals, orchestrator } = setup((req) => {
    if (req.purpose === 'execute' && req.role.id === 'copywriter') prompts.push(req.prompt);
    return demoHandler(req);
  });
  orchestrator.createProject({ name: 'p', goal: 'g' });
  await waitFor(() => !!pendingOf(approvals, 'plan'), 'plan');
  approvals.decide(pendingOf(approvals, 'plan')!.id, true);
  await waitFor(() => prompts.length === 2, 'second copy attempt');
  assert.doesNotMatch(prompts[0], /前回の試行/);
  assert.match(prompts[1], /企画書のペルソナ定義を参照せずに書かれている/);
});

test('計画を却下するとコメントを踏まえて再計画する', async () => {
  const planPrompts: string[] = [];
  const { approvals, orchestrator } = setup((req) => {
    if (req.purpose === 'plan') planPrompts.push(req.prompt);
    return demoHandler(req);
  });
  const project = orchestrator.createProject({ name: 'p', goal: 'g' });
  await waitFor(() => !!pendingOf(approvals, 'plan'), 'first plan');
  approvals.decide(pendingOf(approvals, 'plan')!.id, false, '競合調査を厚くして');
  await waitFor(() => planPrompts.length === 2 && !!pendingOf(approvals, 'plan'), 'second plan');
  assert.match(planPrompts[1], /競合調査を厚くして/);
  assert.equal(project.status, 'awaiting_plan_approval');
});

test('修正上限に達したら人間に判断を仰ぎ、却下でプロジェクトを失敗にする', async () => {
  const handler: MockHandler = (req) => {
    if (req.purpose === 'plan') {
      return {
        rationale: 'r',
        tasks: [{ key: 'a', title: 'A', description: 'd', role: 'researcher', dependsOn: [], reviewers: ['qa_reviewer'], approval: { required: false, category: 'decision', reason: '' } }],
      };
    }
    if (req.purpose === 'review') return { verdict: 'fail', score: 10, issues: ['x'], rootCause: 'y', suggestions: ['z'], rationale: 'bad' };
    return demoHandler(req);
  };
  const { store, approvals, orchestrator } = setup(handler, { maxAttempts: 2 });
  const project = orchestrator.createProject({ name: 'p', goal: 'g' });
  await waitFor(() => !!pendingOf(approvals, 'plan'), 'plan');
  approvals.decide(pendingOf(approvals, 'plan')!.id, true);
  await waitFor(() => !!pendingOf(approvals, 'quality_escalation'), 'escalation');
  const task = store.state.tasks.find((t) => t.projectId === project.id)!;
  assert.equal(task.attempts.length, 2);

  approvals.decide(pendingOf(approvals, 'quality_escalation')!.id, false);
  await waitFor(() => project.status === 'failed', 'failed');

  orchestrator.retry(project.id);
  await waitFor(() => !!pendingOf(approvals, 'quality_escalation'), 'escalation after retry');
  assert.equal(task.attempts.length, 4, '再開後はもう一度上限まで修正できる');
});

test('予算を超えたら一時停止し、承認で予算を追加して続行する', async () => {
  const { approvals, orchestrator } = setup();
  const project = orchestrator.createProject({ name: 'p', goal: 'g', budgetUsd: 0.03 });
  await waitFor(() => !!pendingOf(approvals, 'plan'), 'plan');
  approvals.decide(pendingOf(approvals, 'plan')!.id, true);
  await waitFor(() => !!pendingOf(approvals, 'budget'), 'budget approval');
  await orchestrator.idle();
  assert.equal(project.status, 'paused');
  const spent = project.spentUsd;
  approvals.decide(pendingOf(approvals, 'budget')!.id, true);
  assert.equal(project.status, 'running');
  assert.ok(Math.abs(project.budgetUsd - (spent + 0.03)) < 1e-9);
});

test('エージェントのツール操作承認は決裁されるまで待つ', async () => {
  let decided: boolean | undefined;
  const { approvals, orchestrator } = setup(async (req) => {
    if (req.purpose === 'plan') {
      const d = await req.requestApproval({ category: 'publish', title: 'push', detail: 'git push' });
      decided = d.approved;
    }
    return demoHandler(req);
  });
  orchestrator.createProject({ name: 'p', goal: 'g' });
  await waitFor(() => !!pendingOf(approvals, 'tool'), 'tool approval');
  assert.equal(decided, undefined);
  approvals.decide(pendingOf(approvals, 'tool')!.id, false, 'まだ公開しない');
  await waitFor(() => decided === false, 'agent resumed');
});

test('validatePlan は不正な計画を検出する', () => {
  const t = (key: string, role: string, dependsOn: string[] = []) => ({
    key, title: key, description: '', role, dependsOn, reviewers: ['qa_reviewer'],
    approval: { required: false, category: 'decision' as const, reason: '' },
  });
  const team = DEFAULT_ROLES.filter((r) => ['director', 'qa_reviewer', 'researcher'].includes(r.id));
  assert.equal(validatePlan([t('a', 'researcher'), t('b', 'researcher', ['a'])], team), undefined);
  assert.match(validatePlan([], team)!, /タスクが1つもありません/);
  assert.match(validatePlan([t('a', 'designer')], team)!, /チームにいません/);
  assert.match(validatePlan([t('a', 'researcher', ['zzz'])], team)!, /存在しません/);
  assert.match(validatePlan([t('a', 'researcher', ['b']), t('b', 'researcher', ['a'])], team)!, /循環/);
  assert.match(validatePlan([t('a', 'director')], team)!, /ファイルを保存できません/);
  assert.match(validatePlan([t('a', 'qa_reviewer')], team)!, /ファイルを保存できません/);
});

test('レビュー担当は上限の人数までに絞られる', async () => {
  const { store, approvals, orchestrator } = setup((req) => {
    if (req.purpose !== 'plan') return demoHandler(req);
    return {
      rationale: 'r',
      tasks: [{ key: 'a', title: 'A', description: 'd', role: 'researcher', dependsOn: [], reviewers: ['qa_reviewer', 'director'], approval: { required: false, category: 'decision', reason: '' } }],
    };
  });
  orchestrator.createProject({ name: 'p', goal: 'g' });
  await waitFor(() => !!pendingOf(approvals, 'plan'), 'plan');
  assert.deepEqual(store.state.tasks[0].reviewers, ['qa_reviewer']);
});
