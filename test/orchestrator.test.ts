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

function setup(handler: MockHandler = demoHandler, opts: { maxAttempts?: number; maxReviewers?: number } = {}) {
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
  }, { maxReviewers: 1 });
  orchestrator.createProject({ name: 'p', goal: 'g' });
  await waitFor(() => !!pendingOf(approvals, 'plan'), 'plan');
  assert.deepEqual(store.state.tasks[0].reviewers, ['qa_reviewer']);
});

test('事業の既定チームがプロジェクトに引き継がれ、事業ごとに今月の費用が集計される', async () => {
  const { store, approvals, orchestrator } = setup();
  const biz = orchestrator.createBusiness({ name: '朝食事業', team: ['copywriter'] });
  assert.deepEqual(biz.team, ['director', 'qa_reviewer', 'copywriter']);
  const project = orchestrator.createProject({ name: 'p', goal: 'g', businessId: biz.id });
  assert.equal(project.businessId, biz.id);
  assert.deepEqual(project.team, biz.team);
  assert.throws(() => orchestrator.createProject({ name: 'p', goal: 'g', businessId: 'nope' }), /business not found/);

  await waitFor(() => !!pendingOf(approvals, 'plan'), 'plan');
  assert.ok(orchestrator.businessMonthSpend(biz.id) > 0, '計画の費用が事業の今月分に入る');
  assert.equal(orchestrator.businessMonthSpend(biz.id), project.spentUsd);
  assert.equal(store.state.businesses.length, 1);
});

test('事業の月予算に達したら止まり、承認すると今月に限り続行する', async () => {
  const { approvals, orchestrator } = setup();
  const biz = orchestrator.createBusiness({ name: 'b', monthlyBudgetUsd: 0.02 });
  const project = orchestrator.createProject({ name: 'p', goal: 'g', businessId: biz.id, budgetUsd: 100 });
  await waitFor(() => !!pendingOf(approvals, 'plan'), 'plan');
  approvals.decide(pendingOf(approvals, 'plan')!.id, true);
  await waitFor(() => !!pendingOf(approvals, 'business_budget'), 'business budget approval');
  await orchestrator.idle();
  assert.equal(project.status, 'paused');
  assert.equal(pendingOf(approvals, 'budget'), undefined, 'プロジェクト予算には達していない');

  approvals.decide(pendingOf(approvals, 'business_budget')!.id, true);
  assert.equal(project.status, 'running');
  assert.ok(biz.overBudgetMonth);
  await waitFor(() => !!pendingOf(approvals, 'task_gate') || project.status === 'done', 'continues past monthly budget');
});

test('事業の更新では指定した項目だけが変わる', () => {
  const { orchestrator } = setup();
  const biz = orchestrator.createBusiness({ name: 'b', description: 'd', monthlyBudgetUsd: 5 });
  orchestrator.updateBusiness(biz.id, { monthlyBudgetUsd: null });
  assert.equal(biz.monthlyBudgetUsd, null);
  assert.equal(biz.description, 'd');
  assert.throws(() => orchestrator.updateBusiness(biz.id, { name: ' ' }), /name is required/);
  assert.throws(() => orchestrator.createBusiness({ name: 'x', monthlyBudgetUsd: -1 }), /positive/);
});

test('事業のアーカイブ・削除・プロジェクトの移動', () => {
  const { store, orchestrator } = setup();
  const a = orchestrator.createBusiness({ name: 'A' });
  const b = orchestrator.createBusiness({ name: 'B' });
  const p = orchestrator.createProject({ name: 'p', goal: 'g', businessId: a.id });
  p.spendByMonth['2026-10'] = 1.5;

  assert.throws(() => orchestrator.deleteBusiness(a.id), /アーカイブしてください/);
  orchestrator.moveProject(p.id, b.id);
  assert.equal(p.businessId, b.id);
  assert.equal(orchestrator.businessMonthSpend(b.id, '2026-10'), 1.5, '費用の集計も移る');
  assert.equal(orchestrator.businessMonthSpend(a.id, '2026-10'), 0);
  orchestrator.deleteBusiness(a.id);
  assert.deepEqual(store.state.businesses.map((x) => x.id), [b.id]);

  orchestrator.setBusinessArchived(b.id, true);
  assert.throws(() => orchestrator.createProject({ name: 'q', goal: 'g', businessId: b.id }), /アーカイブ中/);
  orchestrator.moveProject(p.id, null);
  assert.equal(p.businessId, undefined);
  assert.throws(() => orchestrator.moveProject(p.id, b.id), /アーカイブ中/);
  orchestrator.setBusinessArchived(b.id, false);
  orchestrator.moveProject(p.id, b.id);
  assert.equal(p.businessId, b.id);
});

test('KPIは一覧ごと置き換わり、値が変わったものだけ更新日時が変わる', async () => {
  const { orchestrator } = setup();
  const biz = orchestrator.createBusiness({ name: 'b', kpis: [{ name: '月間売上', unit: '円', target: 1000000, current: 250000 }, { name: '会員数', unit: '人' }] });
  assert.equal(biz.kpis.length, 2);
  const [sales, members] = biz.kpis;
  assert.equal(members.target, null);
  await new Promise((r) => setTimeout(r, 5));
  orchestrator.updateBusiness(biz.id, { kpis: [{ ...sales, current: 300000 }, { ...members }] });
  assert.equal(biz.kpis[0].id, sales.id);
  assert.equal(biz.kpis[0].current, 300000);
  assert.notEqual(biz.kpis[0].updatedAt, sales.updatedAt);
  assert.equal(biz.kpis[1].updatedAt, members.updatedAt);
  orchestrator.updateBusiness(biz.id, { kpis: [] });
  assert.equal(biz.kpis.length, 0);
  assert.throws(() => orchestrator.updateBusiness(biz.id, { kpis: [{ name: ' ' }] }), /KPI name is required/);
  assert.throws(() => orchestrator.updateBusiness(biz.id, { kpis: [{ name: 'x', current: NaN }] }), /must be a number/);
});

test('役割は保存され、編集・追加・初期値に戻す・削除ができる', async () => {
  const prompts: string[] = [];
  const { store, approvals, orchestrator } = setup((req) => {
    if (req.purpose === 'plan') prompts.push(req.systemPrompt);
    return demoHandler(req);
  });
  assert.equal(store.state.roles.length, DEFAULT_ROLES.length);
  assert.ok(store.state.roles.every((r) => r.builtin));

  const director = orchestrator.roles.find((r) => r.id === 'director')!;
  const edit = { name: '統括', mission: '新しい使命', criteria: ['基準A', ' ', '基準B'], tools: ['Read'], provider: 'mock', model: 'claude-sonnet-5-5', effort: 'low' as const };
  orchestrator.updateRole('director', edit);
  assert.deepEqual(director.criteria, ['基準A', '基準B'], '空行は捨てる');
  assert.equal(director.model, 'claude-sonnet-5-5');

  orchestrator.createProject({ name: 'p', goal: 'g' });
  await waitFor(() => prompts.length === 1, 'plan');
  assert.match(prompts[0], /新しい使命/, '編集した使命と判断基準が次の作業から使われる');
  assert.match(prompts[0], /- 基準B/);

  orchestrator.resetRole('director');
  assert.equal(director.mission, DEFAULT_ROLES.find((r) => r.id === 'director')!.mission);
  assert.equal(director.model, undefined);
  assert.throws(() => orchestrator.deleteRole('director'), /削除できません/);

  const sns = orchestrator.createRole({ name: 'SNS運用', mission: '投稿を作る', criteria: ['炎上しない'], tools: ['Read', 'Write'], provider: 'mock' });
  assert.match(sns.id, /^custom_/);
  assert.throws(() => orchestrator.resetRole(sns.id), /初期値に戻せません/);
  const biz = orchestrator.createBusiness({ name: 'b', team: [sns.id] });
  assert.throws(() => orchestrator.deleteRole(sns.id), /事業「b」/);
  orchestrator.updateBusiness(biz.id, { team: ['researcher'] });
  orchestrator.deleteRole(sns.id);
  assert.equal(orchestrator.roles.some((r) => r.id === sns.id), false);
  await orchestrator.idle();
  void approvals;
});

test('役割の入力は検証される', () => {
  const { orchestrator } = setup();
  const ok = { name: 'x', mission: 'm', criteria: ['c'], tools: ['Read'], provider: 'mock' };
  assert.throws(() => orchestrator.createRole({ ...ok, name: ' ' }), /名前/);
  assert.throws(() => orchestrator.createRole({ ...ok, criteria: [' '] }), /判断基準/);
  assert.throws(() => orchestrator.createRole({ ...ok, tools: ['Read', 'mcp__evil'] }), /使えないツール/);
  assert.throws(() => orchestrator.createRole({ ...ok, provider: 'nope' }), /AIサービス/);
  assert.throws(() => orchestrator.createRole({ ...ok, model: 'gpt-x' }), /モデル/);
  assert.throws(() => orchestrator.createRole({ ...ok, effort: 'turbo' as never }), /思考レベル/);
});

test('月予算の承認は事業単位で、同じ事業の承認待ちをまとめて片付ける', async () => {
  const { approvals, orchestrator } = setup();
  const biz = orchestrator.createBusiness({ name: 'b', monthlyBudgetUsd: 0.015 });
  const other = orchestrator.createBusiness({ name: 'other', monthlyBudgetUsd: 0.015 });
  const p1 = orchestrator.createProject({ name: 'p1', goal: 'g', businessId: biz.id });
  const p2 = orchestrator.createProject({ name: 'p2', goal: 'g', businessId: biz.id });
  const p3 = orchestrator.createProject({ name: 'p3', goal: 'g', businessId: other.id });
  await waitFor(() => approvals.pending().filter((a) => a.kind === 'plan').length === 3, 'plans');
  for (const a of approvals.pending()) approvals.decide(a.id, true);
  await waitFor(() => approvals.pending().filter((a) => a.kind === 'business_budget').length === 3, 'three budget approvals');
  await orchestrator.idle();
  assert.deepEqual([p1, p2, p3].map((p) => p.status), ['paused', 'paused', 'paused']);

  const forP1 = approvals.pending().find((a) => a.kind === 'business_budget' && a.projectId === p1.id)!;
  approvals.decide(forP1.id, true);
  const left = approvals.pending().filter((a) => a.kind === 'business_budget');
  assert.deepEqual(left.map((a) => a.projectId), [p3.id], '同じ事業の p2 の承認待ちもまとめて承認され、別事業の p3 は残る');
  assert.equal(p1.status, 'running');
  assert.equal(p2.status, 'running');
  assert.equal(p3.status, 'paused');
});
