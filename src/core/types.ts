// ドメインモデル。永続化(state.json)・API・ダッシュボードはすべてこの型を共有する。

export type RoleId = string;

/** 専門AIの役割定義。mission と criteria がそのままエージェントへの指示と評価基準になる。 */
export interface RoleDefinition {
  id: RoleId;
  name: string;
  mission: string;
  /** 成果物の判断基準。実行時は自己チェック、レビュー時は採点基準として使う。 */
  criteria: string[];
  /** 使用するプロバイダID(claude-code / command / mock …)。 */
  provider: string;
  /** プロバイダに許可するツール。Claude Code では Options.tools に渡る。 */
  tools: string[];
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** 人間の最終承認が必要な操作の種類。 */
export type ApprovalCategory = 'decision' | 'publish' | 'cost';

/** 承認が発生した場面。オーケストレータは kind ごとに承認/却下後の遷移を決める。 */
export type ApprovalKind =
  | 'plan' // 計画(タスク分解・役割分担)の承認
  | 'task_gate' // 外部公開・費用発生を伴うタスク成果の承認
  | 'quality_escalation' // 修正上限に達しても品質基準を満たせなかった
  | 'budget' // プロジェクト予算の超過
  | 'business_budget' // 事業の月予算の超過
  | 'tool'; // エージェントが実行しようとした危険なツール操作

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRequest {
  id: string;
  projectId: string;
  taskId?: string;
  kind: ApprovalKind;
  category: ApprovalCategory;
  title: string;
  detail: string;
  requestedBy: RoleId | 'system';
  status: ApprovalStatus;
  comment?: string;
  createdAt: string;
  decidedAt?: string;
}

/** 事業の成果指標(売上・会員数など)。 */
export interface Kpi {
  id: string;
  name: string;
  unit: string;
  target: number | null;
  current: number | null;
  updatedAt: string;
}

/** 事業。複数のプロジェクトをまとめ、既定のチームと月予算を持つ。 */
export interface Business {
  id: string;
  name: string;
  description: string;
  /** この事業で新しいプロジェクトを作るときの既定のチーム。 */
  team: RoleId[];
  /** 事業全体の月予算(USD)。null は上限なし。 */
  monthlyBudgetUsd: number | null;
  /** 事業の成果指標。値は人間が入力する。 */
  kpis: Kpi[];
  /** アーカイブした日時。アーカイブ中は一覧に出さず、新しいプロジェクトも作れない。 */
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ProjectStatus =
  | 'planning'
  | 'awaiting_plan_approval'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed';

export interface Project {
  id: string;
  name: string;
  goal: string;
  businessId?: string;
  /** このプロジェクトで使える役割。計画者はこの中から担当を選ぶ。 */
  team: RoleId[];
  status: ProjectStatus;
  budgetUsd: number;
  /** 予算超過の承認1回あたりに追加する額。 */
  budgetStepUsd: number;
  spentUsd: number;
  /** 月ごとの費用('YYYY-MM' → USD)。事業の月予算の集計に使う。 */
  spendByMonth: Record<string, number>;
  /** 事業の月予算を超えて続行することを人間が承認した月。 */
  overBudgetMonth?: string;
  planRationale?: string;
  /** 計画が却下されたときの人間のコメント。再計画時に渡す。 */
  planFeedback?: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'reviewing'
  | 'awaiting_approval'
  | 'done'
  | 'failed';

export interface Review {
  reviewer: RoleId;
  verdict: 'pass' | 'fail';
  score: number;
  issues: string[];
  rootCause: string;
  suggestions: string[];
  rationale: string;
}

export interface Deliverable {
  path: string;
  description: string;
}

/** 1回の実行(初回 or 修正)とそれに対するレビュー。 */
export interface Attempt {
  n: number;
  summary: string;
  rationale: string;
  deliverables: Deliverable[];
  openQuestions: string[];
  reviews: Review[];
  costUsd: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface Task {
  id: string;
  projectId: string;
  /** 計画内での参照キー。dependsOn はこのキーを指す。 */
  key: string;
  title: string;
  description: string;
  role: RoleId;
  dependsOn: string[];
  reviewers: RoleId[];
  approval: { required: boolean; category: ApprovalCategory; reason: string } | null;
  status: TaskStatus;
  attempts: Attempt[];
  /** 試行回数の上限を数え始める位置。人間が差し戻すと進み、再び上限まで修正できる。 */
  retryBase: number;
  /** 人間が承認ゲートで却下したときのコメント。次の修正で渡す。 */
  humanFeedback?: string;
  createdAt: string;
  updatedAt: string;
}

export type EventKind = 'info' | 'progress' | 'decision' | 'review' | 'approval' | 'error';

export interface LogEvent {
  id: string;
  ts: string;
  projectId: string;
  taskId?: string;
  agent?: RoleId | 'system' | 'human';
  kind: EventKind;
  message: string;
}

export interface State {
  businesses: Business[];
  projects: Project[];
  tasks: Task[];
  approvals: ApprovalRequest[];
}
