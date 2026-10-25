import { newId, now, type Store } from './store.ts';
import type { ApprovalCategory, ApprovalKind, ApprovalRequest, RoleId } from './types.ts';

const CATEGORY_LABEL: Record<ApprovalCategory, string> = { decision: '意思決定', publish: '外部公開', cost: '費用' };

export interface ApprovalInput {
  projectId: string;
  taskId?: string;
  kind: ApprovalKind;
  category: ApprovalCategory;
  title: string;
  detail: string;
  requestedBy: RoleId | 'system';
}

export interface ApprovalDecision {
  approved: boolean;
  comment?: string;
}

/**
 * 人間の承認待ちを管理する。承認依頼は永続化され、ダッシュボードから決裁される。
 * 決裁は 'decided' イベントでオーケストレータに通知され、wait() で待っている呼び出し元も再開する。
 */
export class Approvals {
  private waiters = new Map<string, (d: ApprovalDecision) => void>();
  private listeners: Array<(a: ApprovalRequest) => void> = [];

  constructor(private readonly store: Store) {}

  request(input: ApprovalInput): ApprovalRequest {
    const approval: ApprovalRequest = { id: newId(), status: 'pending', createdAt: now(), ...input };
    this.store.state.approvals.push(approval);
    this.store.log({
      projectId: input.projectId,
      taskId: input.taskId,
      agent: input.requestedBy,
      kind: 'approval',
      message: `承認依頼 [${CATEGORY_LABEL[input.category]}] ${input.title}`,
    });
    this.store.changed();
    return approval;
  }

  /** 承認依頼を出し、人間が決裁するまで待つ。 */
  async requestAndWait(input: ApprovalInput, signal?: AbortSignal): Promise<ApprovalDecision> {
    const approval = this.request(input);
    return new Promise((resolve, reject) => {
      this.waiters.set(approval.id, resolve);
      signal?.addEventListener('abort', () => {
        this.waiters.delete(approval.id);
        this.expire(approval.id);
        reject(new Error('aborted'));
      });
    });
  }

  decide(id: string, approved: boolean, comment?: string): ApprovalRequest {
    const approval = this.store.state.approvals.find((a) => a.id === id);
    if (!approval) throw new Error(`approval not found: ${id}`);
    if (approval.status !== 'pending') throw new Error(`approval already ${approval.status}`);
    approval.status = approved ? 'approved' : 'rejected';
    approval.comment = comment?.trim() || undefined;
    approval.decidedAt = now();
    this.store.log({
      projectId: approval.projectId,
      taskId: approval.taskId,
      agent: 'human',
      kind: 'approval',
      message: `${approved ? '承認' : '却下'}: ${approval.title}${approval.comment ? ` — ${approval.comment}` : ''}`,
    });
    this.store.changed();
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    waiter?.({ approved, comment: approval.comment });
    for (const l of this.listeners) l(approval);
    return approval;
  }

  onDecided(listener: (a: ApprovalRequest) => void): void {
    this.listeners.push(listener);
  }

  /** 待ち手がいなくなった依頼(再起動で中断したツール承認など)を無効にする。 */
  expire(id: string): void {
    const approval = this.store.state.approvals.find((a) => a.id === id);
    if (!approval || approval.status !== 'pending') return;
    approval.status = 'expired';
    approval.decidedAt = now();
    this.store.changed();
  }

  pending(projectId?: string): ApprovalRequest[] {
    return this.store.state.approvals.filter(
      (a) => a.status === 'pending' && (!projectId || a.projectId === projectId),
    );
  }
}
