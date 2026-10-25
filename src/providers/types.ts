import type { ApprovalDecision } from '../core/approvals.ts';
import type { ApprovalCategory, RoleDefinition } from '../core/types.ts';

/** plan: 計画立案 / execute: タスク実行・修正 / review: 他エージェントの成果の検証 */
export type RunPurpose = 'plan' | 'execute' | 'review';

export interface AgentRunRequest {
  purpose: RunPurpose;
  role: RoleDefinition;
  systemPrompt: string;
  prompt: string;
  /** 最終出力が従うべきJSONスキーマ。 */
  outputSchema: Record<string, unknown>;
  /** エージェントの作業ディレクトリ(プロジェクトごとのワークスペース)。 */
  cwd: string;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
  /** 作業状況をダッシュボードに流す。 */
  onProgress: (message: string) => void;
  /** 外部公開・費用発生などの操作の前に、人間の承認を求める。 */
  requestApproval: (req: {
    category: ApprovalCategory;
    title: string;
    detail: string;
  }) => Promise<ApprovalDecision>;
}

export interface AgentRunResult {
  output: unknown;
  costUsd: number;
}

/**
 * AIサービスの差し替え口。Claude Code 以外(Codex など)はこのインターフェースを実装して
 * registry に登録すれば、役割の provider に指定して使える。
 */
export interface AgentProvider {
  readonly id: string;
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}
