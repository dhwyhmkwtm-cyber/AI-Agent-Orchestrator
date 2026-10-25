import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { AgentRunRequest, RunPurpose } from '../providers/types.ts';
import type { Approvals } from './approvals.ts';
import {
  EXECUTION_SCHEMA,
  PLAN_SCHEMA,
  REVIEW_SCHEMA,
  executionPrompt,
  planPrompt,
  reviewPrompt,
  roleSystemPrompt,
} from './prompts.ts';
import { monthKey, newId, now, type Store } from './store.ts';
import type { ApprovalCategory, ApprovalRequest, Attempt, Business, Project, Review, RoleDefinition, Task } from './types.ts';

export interface OrchestratorOptions {
  store: Store;
  approvals: Approvals;
  providers: ProviderRegistry;
  roles: RoleDefinition[];
  workspaceRoot: string;
  /** 指定すると全役割をこのプロバイダで動かす(デモ・テスト用)。 */
  providerOverride?: string;
  /** 人間に判断を仰ぐまでの、実行+レビューの最大試行回数。 */
  maxAttempts?: number;
  maxParallel?: number;
  /** 1タスクあたりのレビュー担当の上限。レビュー1人ごとに費用がかかる。 */
  maxReviewers?: number;
  /** レビュー合格に必要な点数。 */
  passScore?: number;
}

export interface CreateProjectInput {
  name: string;
  goal: string;
  businessId?: string;
  /** 省略すると事業の既定チーム(事業もなければ全役割)を使う。 */
  team?: string[];
  budgetUsd?: number;
}

export interface BusinessInput {
  name: string;
  description?: string;
  team?: string[];
  monthlyBudgetUsd?: number | null;
}

const REQUIRED_ROLES = ['director', 'qa_reviewer'];
const PLAN_RETRIES = 2;

interface PlannedTask {
  key: string;
  title: string;
  description: string;
  role: string;
  dependsOn: string[];
  reviewers: string[];
  approval: { required: boolean; category: ApprovalCategory; reason: string };
}

/**
 * 統括エンジン。プロジェクトごとに「計画 → 承認 → 実行 → 相互レビュー → 修正 → 承認」を回す。
 * 状態はすべて Store にあり、tick() が現在の状態から次にやることを決める。
 * そのため再起動しても resume() で途中から再開できる。
 */
export class Orchestrator {
  private readonly store: Store;
  private readonly approvals: Approvals;
  private readonly inflight = new Map<string, AbortController>();
  private readonly maxAttempts: number;
  private readonly maxParallel: number;
  private readonly maxReviewers: number;
  private readonly passScore: number;

  constructor(private readonly opts: OrchestratorOptions) {
    this.store = opts.store;
    this.approvals = opts.approvals;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.maxParallel = opts.maxParallel ?? 2;
    this.maxReviewers = Math.max(1, opts.maxReviewers ?? 1);
    this.passScore = opts.passScore ?? 70;
    this.approvals.onDecided((a) => this.onDecided(a));
  }

  get roles(): RoleDefinition[] {
    return this.opts.roles;
  }

  /** すべてのバックグラウンド処理が終わるまで待つ(テスト用)。 */
  async idle(): Promise<void> {
    while (this.inflight.size) await new Promise((r) => setTimeout(r, 5));
  }

  createBusiness(input: BusinessInput): Business {
    const business: Business = {
      id: newId(),
      name: '',
      description: '',
      team: [...REQUIRED_ROLES],
      monthlyBudgetUsd: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.applyBusinessInput(business, input);
    this.store.state.businesses.push(business);
    this.store.changed();
    return business;
  }

  updateBusiness(id: string, input: Partial<BusinessInput>): Business {
    const business = this.business(id);
    this.applyBusinessInput(business, { ...business, ...input });
    business.updatedAt = now();
    this.store.changed();
    return business;
  }

  private applyBusinessInput(business: Business, input: BusinessInput): void {
    if (!input.name?.trim()) throw new Error('name is required');
    const budget = input.monthlyBudgetUsd;
    if (budget !== null && budget !== undefined && !(budget > 0)) throw new Error('monthlyBudgetUsd must be positive');
    business.name = input.name.trim();
    business.description = input.description?.trim() ?? '';
    business.team = this.resolveTeam(input.team?.length ? input.team : this.roles.map((r) => r.id));
    business.monthlyBudgetUsd = budget ?? null;
  }

  /** 事業の今月の費用。 */
  businessMonthSpend(businessId: string, month = monthKey()): number {
    return this.store.state.projects
      .filter((p) => p.businessId === businessId)
      .reduce((sum, p) => sum + (p.spendByMonth[month] ?? 0), 0);
  }

  createProject(input: CreateProjectInput): Project {
    if (!input.name?.trim() || !input.goal?.trim()) throw new Error('name and goal are required');
    const business = input.businessId ? this.business(input.businessId) : undefined;
    const requested = input.team?.length ? input.team : business?.team ?? this.roles.map((r) => r.id);
    const budget = input.budgetUsd ?? 10;
    if (!(budget > 0)) throw new Error('budgetUsd must be positive');
    const project: Project = {
      id: newId(),
      name: input.name.trim(),
      goal: input.goal.trim(),
      businessId: business?.id,
      team: this.resolveTeam(requested),
      spendByMonth: {},
      status: 'planning',
      budgetUsd: budget,
      budgetStepUsd: budget,
      spentUsd: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    mkdirSync(this.workspace(project), { recursive: true });
    this.store.state.projects.push(project);
    this.store.log({ projectId: project.id, agent: 'human', kind: 'info', message: `プロジェクト作成: ${project.name}` });
    this.store.changed();
    this.tick();
    return project;
  }

  /** 役割IDを検証し、必須の役割を加える。 */
  private resolveTeam(ids: string[]): string[] {
    const known = new Set(this.roles.map((r) => r.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`unknown roles: ${unknown.join(', ')}`);
    return [...new Set([...REQUIRED_ROLES, ...ids])];
  }

  /** 失敗したプロジェクトを、失敗した箇所からやり直す。 */
  retry(projectId: string): void {
    const project = this.project(projectId);
    if (project.status !== 'failed') throw new Error(`project is ${project.status}`);
    const tasks = this.tasksOf(project);
    for (const t of tasks.filter((t) => t.status === 'failed')) {
      t.status = 'pending';
      t.retryBase = t.attempts.length;
    }
    this.setProjectStatus(project, tasks.length ? 'running' : 'planning');
    this.tick();
  }

  /** 起動時に呼ぶ。中断された実行を最初からやり直し、待ち手のいないツール承認を無効にする。 */
  resume(): void {
    for (const t of this.store.state.tasks) {
      if (t.status === 'running' || t.status === 'reviewing') {
        const last = t.attempts.at(-1);
        if (last && !last.finishedAt) t.attempts.pop();
        t.status = 'pending';
      }
    }
    for (const a of this.approvals.pending()) if (a.kind === 'tool') this.approvals.expire(a.id);
    this.store.changed();
    this.tick();
  }

  /** 現在の状態を見て、始められる処理をすべて始める。 */
  tick(): void {
    for (const project of this.store.state.projects) {
      if (project.status === 'planning') this.spawn(`plan:${project.id}`, () => this.plan(project));
      if (project.status !== 'running') continue;

      const tasks = this.tasksOf(project);
      if (tasks.some((t) => t.status === 'failed')) {
        this.setProjectStatus(project, 'failed');
        continue;
      }
      if (tasks.every((t) => t.status === 'done')) {
        this.setProjectStatus(project, 'done');
        this.store.log({ projectId: project.id, agent: 'system', kind: 'info', message: 'プロジェクト完了' });
        continue;
      }
      const doneKeys = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.key));
      for (const task of tasks) {
        if (task.status !== 'pending' || !task.dependsOn.every((k) => doneKeys.has(k))) continue;
        if (this.runningTaskCount() >= this.maxParallel) break;
        this.spawn(task.id, () => this.runTask(project, task));
      }
    }
  }

  // ---------------------------------------------------------------- 計画

  private async plan(project: Project): Promise<void> {
    const director = this.role('director');
    const team = project.team.map((id) => this.role(id));
    let error: string | undefined;
    for (let i = 0; i <= PLAN_RETRIES; i++) {
      if (!this.ensureBudget(project)) return;
      const output = (await this.call('plan', project, undefined, director, planPrompt(project, team, this.maxReviewers, error), PLAN_SCHEMA)) as {
        rationale: string;
        tasks: PlannedTask[];
      };
      error = validatePlan(output.tasks, team);
      if (error) {
        this.store.log({ projectId: project.id, agent: 'director', kind: 'error', message: `計画に不備: ${error}` });
        continue;
      }
      this.installPlan(project, output.rationale, output.tasks);
      return;
    }
    throw new Error(`有効な計画を作れませんでした: ${error}`);
  }

  private installPlan(project: Project, rationale: string, planned: PlannedTask[]): void {
    this.store.state.tasks = this.store.state.tasks.filter((t) => t.projectId !== project.id);
    for (const p of planned) {
      let reviewers = [...new Set(p.reviewers)].filter((r) => r !== p.role).slice(0, this.maxReviewers);
      if (!reviewers.length) reviewers = [p.role === 'qa_reviewer' ? 'director' : 'qa_reviewer'];
      this.store.state.tasks.push({
        id: newId(),
        projectId: project.id,
        key: p.key,
        title: p.title,
        description: p.description,
        role: p.role,
        dependsOn: p.dependsOn,
        reviewers,
        approval: p.approval.required ? p.approval : null,
        status: 'pending',
        attempts: [],
        retryBase: 0,
        createdAt: now(),
        updatedAt: now(),
      });
    }
    project.planRationale = rationale;
    this.store.log({
      projectId: project.id,
      agent: 'director',
      kind: 'decision',
      message: `計画を作成 (${planned.length}タスク): ${rationale}`,
    });
    this.setProjectStatus(project, 'awaiting_plan_approval');
    this.approvals.request({
      projectId: project.id,
      kind: 'plan',
      category: 'decision',
      title: `計画の承認: ${project.name}`,
      detail: [rationale, '', ...planned.map((p, i) => `${i + 1}. [${p.role}] ${p.title}${p.approval.required ? ' ⚠承認制' : ''}`)].join('\n'),
      requestedBy: 'director',
    });
  }

  // ---------------------------------------------------------------- 実行・レビュー・修正

  private async runTask(project: Project, task: Task): Promise<void> {
    const executor = this.role(task.role);
    for (;;) {
      if (!this.ensureBudget(project)) {
        this.setTaskStatus(task, 'pending');
        return;
      }
      // プロンプトは新しい試行を積む前に作る(直前の試行とレビューを修正指示として渡すため)
      const deps = this.tasksOf(project).filter((t) => task.dependsOn.includes(t.key));
      const prompt = executionPrompt(project, task, deps);
      const attempt: Attempt = {
        n: task.attempts.length + 1,
        summary: '',
        rationale: '',
        deliverables: [],
        openQuestions: [],
        reviews: [],
        costUsd: 0,
        startedAt: now(),
      };
      task.attempts.push(attempt);
      this.setTaskStatus(task, 'running');
      this.log(task, executor.id, 'info', attempt.n === 1 ? `着手: ${task.title}` : `修正に着手 (試行${attempt.n})`);

      try {
        const out = (await this.call('execute', project, task, executor, prompt, EXECUTION_SCHEMA)) as Pick<
          Attempt,
          'summary' | 'rationale' | 'deliverables' | 'openQuestions'
        >;
        Object.assign(attempt, out);
        this.log(task, executor.id, 'decision', `提出: ${out.summary}`);

        this.setTaskStatus(task, 'reviewing');
        attempt.reviews = await Promise.all(
          task.reviewers.map(async (reviewerId): Promise<Review> => {
            const reviewer = this.role(reviewerId);
            const r = (await this.call('review', project, task, reviewer, reviewPrompt(project, task, executor, attempt), REVIEW_SCHEMA)) as Omit<
              Review,
              'reviewer'
            >;
            this.log(task, reviewerId, 'review', `${r.verdict === 'pass' ? '合格' : '差し戻し'} (${r.score}点): ${r.rationale}`);
            return { reviewer: reviewerId, ...r };
          }),
        );
      } catch (err) {
        attempt.error = err instanceof Error ? err.message : String(err);
        this.log(task, executor.id, 'error', `実行エラー: ${attempt.error}`);
      }
      attempt.finishedAt = now();

      const passed = !attempt.error && attempt.reviews.every((r) => r.verdict === 'pass' && r.score >= this.passScore);
      if (passed) {
        if (task.approval?.required) {
          this.setTaskStatus(task, 'awaiting_approval');
          this.approvals.request({
            projectId: project.id,
            taskId: task.id,
            kind: 'task_gate',
            category: task.approval.category,
            title: `${task.title}(${task.approval.reason})`,
            detail: `${attempt.summary}\n\n判断理由: ${attempt.rationale}`,
            requestedBy: task.role,
          });
        } else {
          this.setTaskStatus(task, 'done');
          this.log(task, 'system', 'info', `完了: ${task.title}`);
        }
        return;
      }

      if (task.attempts.length - task.retryBase >= this.maxAttempts) {
        this.setTaskStatus(task, 'awaiting_approval');
        const issues = attempt.error ? [attempt.error] : attempt.reviews.flatMap((r) => r.issues);
        this.approvals.request({
          projectId: project.id,
          taskId: task.id,
          kind: 'quality_escalation',
          category: 'decision',
          title: `品質基準未達: ${task.title}`,
          detail: `${this.maxAttempts}回修正しても基準を満たせませんでした。承認すると現状で完了扱い、却下するとタスクを失敗にします。\n\n残っている問題:\n${issues.map((i) => `- ${i}`).join('\n')}`,
          requestedBy: 'system',
        });
        return;
      }
      this.log(task, 'system', 'decision', '基準未達のため、指摘をもとに修正します');
    }
  }

  // ---------------------------------------------------------------- 承認後の遷移

  private onDecided(a: ApprovalRequest): void {
    const project = this.store.state.projects.find((p) => p.id === a.projectId);
    const task = a.taskId ? this.store.state.tasks.find((t) => t.id === a.taskId) : undefined;
    if (!project) return;
    const approved = a.status === 'approved';

    switch (a.kind) {
      case 'plan':
        if (approved) {
          this.setProjectStatus(project, 'running');
        } else {
          project.planFeedback = a.comment ?? '計画が却下されました。別の進め方を検討してください。';
          this.setProjectStatus(project, 'planning');
        }
        break;
      case 'task_gate':
        if (!task) return;
        if (approved) {
          this.setTaskStatus(task, 'done');
        } else {
          task.humanFeedback = a.comment ?? '承認されませんでした。内容を見直してください。';
          task.retryBase = task.attempts.length;
          this.setTaskStatus(task, 'pending');
        }
        break;
      case 'quality_escalation':
        if (task) this.setTaskStatus(task, approved ? 'done' : 'failed');
        break;
      case 'budget':
      case 'business_budget':
        if (approved) {
          if (a.kind === 'budget') project.budgetUsd = project.spentUsd + project.budgetStepUsd;
          else project.overBudgetMonth = monthKey();
          const hasTasks = this.tasksOf(project).length > 0;
          this.setProjectStatus(project, hasTasks ? 'running' : 'planning');
        }
        break;
      case 'tool':
        return; // 待っているエージェントが直接再開する
    }
    this.tick();
  }

  // ---------------------------------------------------------------- 補助

  private async call(
    purpose: RunPurpose,
    project: Project,
    task: Task | undefined,
    role: RoleDefinition,
    prompt: string,
    outputSchema: Record<string, unknown>,
  ): Promise<unknown> {
    const provider = this.opts.providers.get(this.opts.providerOverride ?? role.provider);
    const controller = this.inflight.get(task?.id ?? `plan:${project.id}`);
    const req: AgentRunRequest = {
      purpose,
      role,
      systemPrompt: roleSystemPrompt(role),
      prompt,
      outputSchema,
      cwd: this.workspace(project),
      maxBudgetUsd: Math.max(project.budgetUsd - project.spentUsd, 0.01),
      signal: controller?.signal,
      onProgress: (message) => this.store.log({ projectId: project.id, taskId: task?.id, agent: role.id, kind: 'progress', message }),
      requestApproval: (r) =>
        this.approvals.requestAndWait(
          { projectId: project.id, taskId: task?.id, kind: 'tool', requestedBy: role.id, ...r },
          controller?.signal,
        ),
    };
    const result = await provider.run(req);
    project.spentUsd += result.costUsd;
    const month = monthKey();
    project.spendByMonth[month] = (project.spendByMonth[month] ?? 0) + result.costUsd;
    this.store.log({
      projectId: project.id,
      taskId: task?.id,
      agent: role.id,
      kind: 'info',
      message: `費用 $${result.costUsd.toFixed(3)} (${purpose}) / 累計 $${project.spentUsd.toFixed(3)}`,
    });
    if (task) task.attempts.at(-1)!.costUsd += result.costUsd;
    this.store.changed();
    return result.output;
  }

  /** 予算内なら true。超えていれば一時停止して追加予算の承認を求める。 */
  private ensureBudget(project: Project): boolean {
    if (project.spentUsd >= project.budgetUsd) {
      return this.pauseForBudget(project, 'budget', `予算超過: ${project.name}`,
        `使用額 $${project.spentUsd.toFixed(2)} が予算 $${project.budgetUsd.toFixed(2)} に達しました。承認すると $${project.budgetStepUsd.toFixed(2)} を追加して続行します。`);
    }
    const business = project.businessId ? this.store.state.businesses.find((b) => b.id === project.businessId) : undefined;
    const month = monthKey();
    if (business?.monthlyBudgetUsd && project.overBudgetMonth !== month) {
      const spent = this.businessMonthSpend(business.id, month);
      if (spent >= business.monthlyBudgetUsd) {
        return this.pauseForBudget(project, 'business_budget', `月予算超過: ${business.name}`,
          `事業「${business.name}」の今月の費用 $${spent.toFixed(2)} が月予算 $${business.monthlyBudgetUsd.toFixed(2)} に達しました。承認すると、プロジェクト「${project.name}」は今月に限り月予算を超えて続行します。`);
      }
    }
    return true;
  }

  /** 一時停止して予算の承認を求める。常に false を返す。 */
  private pauseForBudget(project: Project, kind: 'budget' | 'business_budget', title: string, detail: string): false {
    if (project.status !== 'paused') this.setProjectStatus(project, 'paused');
    if (!this.approvals.pending(project.id).some((a) => a.kind === kind)) {
      this.approvals.request({ projectId: project.id, kind, category: 'cost', title, detail, requestedBy: 'system' });
    }
    return false;
  }

  private spawn(key: string, work: () => Promise<void>): void {
    if (this.inflight.has(key)) return;
    this.inflight.set(key, new AbortController());
    void work()
      .catch((err: unknown) => {
        const projectId = key.startsWith('plan:') ? key.slice(5) : this.store.state.tasks.find((t) => t.id === key)?.projectId;
        const project = this.store.state.projects.find((p) => p.id === projectId);
        if (!project) return;
        this.store.log({ projectId: project.id, agent: 'system', kind: 'error', message: `停止: ${err instanceof Error ? err.message : String(err)}` });
        const task = this.store.state.tasks.find((t) => t.id === key);
        if (task) this.setTaskStatus(task, 'failed');
        this.setProjectStatus(project, 'failed');
      })
      .finally(() => {
        this.inflight.delete(key);
        this.tick();
      });
  }

  private runningTaskCount(): number {
    return [...this.inflight.keys()].filter((k) => !k.startsWith('plan:')).length;
  }

  private workspace(project: Project): string {
    return join(this.opts.workspaceRoot, project.id);
  }

  private business(id: string): Business {
    const business = this.store.state.businesses.find((b) => b.id === id);
    if (!business) throw new Error(`business not found: ${id}`);
    return business;
  }

  private project(id: string): Project {
    const project = this.store.state.projects.find((p) => p.id === id);
    if (!project) throw new Error(`project not found: ${id}`);
    return project;
  }

  private tasksOf(project: Project): Task[] {
    return this.store.state.tasks.filter((t) => t.projectId === project.id);
  }

  private role(id: string): RoleDefinition {
    const role = this.roles.find((r) => r.id === id);
    if (!role) throw new Error(`role not found: ${id}`);
    return role;
  }

  private setProjectStatus(project: Project, status: Project['status']): void {
    project.status = status;
    project.updatedAt = now();
    this.store.changed();
  }

  private setTaskStatus(task: Task, status: Task['status']): void {
    task.status = status;
    task.updatedAt = now();
    this.store.changed();
  }

  private log(task: Task, agent: string, kind: 'info' | 'decision' | 'review' | 'error', message: string): void {
    this.store.log({ projectId: task.projectId, taskId: task.id, agent, kind, message });
  }
}

export const canWriteFiles = (role: RoleDefinition): boolean => role.tools.includes('Write');

/** 計画の整合性を検証する。問題があれば説明文を返す。 */
export function validatePlan(tasks: PlannedTask[], teamRoles: RoleDefinition[]): string | undefined {
  if (!tasks.length) return 'タスクが1つもありません';
  const team = teamRoles.map((r) => r.id);
  const keys = new Set<string>();
  for (const t of tasks) {
    if (keys.has(t.key)) return `key が重複しています: ${t.key}`;
    keys.add(t.key);
  }
  for (const t of tasks) {
    const role = teamRoles.find((r) => r.id === t.role);
    if (!role) return `タスク ${t.key} の担当 ${t.role} はチームにいません`;
    // 成果物はファイルで提出させるため、書き込めない役割には担当させない
    if (!canWriteFiles(role)) return `タスク ${t.key} の担当 ${t.role} はファイルを保存できません。成果物を作るタスクは書き込みできる役割に割り当ててください`;
    const badReviewer = t.reviewers.find((r) => !team.includes(r));
    if (badReviewer) return `タスク ${t.key} のレビュアー ${badReviewer} はチームにいません`;
    const badDep = t.dependsOn.find((d) => !keys.has(d));
    if (badDep) return `タスク ${t.key} の依存先 ${badDep} が存在しません`;
  }
  // 循環依存の検出
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (k: string): boolean => {
    if (visited.has(k)) return false;
    if (visiting.has(k)) return true;
    visiting.add(k);
    const cyclic = deps.get(k)!.some(visit);
    visiting.delete(k);
    visited.add(k);
    return cyclic;
  };
  const cyclic = tasks.find((t) => visit(t.key));
  if (cyclic) return `依存関係が循環しています(${cyclic.key} を含む)`;
  return undefined;
}
