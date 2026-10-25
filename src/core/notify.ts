import webpush from 'web-push';
import type { Approvals } from './approvals.ts';
import { now, type Store } from './store.ts';
import type { ApprovalRequest, PushSubscriptionRecord } from './types.ts';

const CATEGORY_LABEL = { decision: '意思決定', publish: '外部公開', cost: '費用' } as const;

export interface PushPayload {
  title: string;
  body: string;
  /** 同じ tag の通知は端末上で1つにまとまる。 */
  tag: string;
  url: string;
  /** ホーム画面アイコンのバッジに出す承認待ちの件数。 */
  badge: number;
}

export type SendPush = (sub: PushSubscriptionRecord, payload: string) => Promise<unknown>;

/**
 * 承認依頼を Web Push で端末(iPad のホーム画面アプリなど)に通知する。
 * 通知には承認の中身を詳しく書かず、開いて確認してもらう(ロック画面に出るため)。
 */
export class PushNotifier {
  private readonly send: SendPush;

  constructor(
    private readonly store: Store,
    approvals: Approvals,
    vapid: { publicKey: string; privateKey: string; subject: string },
    send?: SendPush,
  ) {
    this.send = send ?? ((sub, payload) => webpush.sendNotification(sub, payload, { vapidDetails: vapid, TTL: 24 * 3600, urgency: 'high' }));
    approvals.onRequested((a) => void this.notifyApproval(a));
  }

  subscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, label: string): PushSubscriptionRecord {
    let url: URL;
    try {
      url = new URL(sub.endpoint);
    } catch {
      throw new Error('endpoint が正しくありません');
    }
    if (url.protocol !== 'https:') throw new Error('endpoint は https である必要があります');
    // 端末の公開鍵は65バイト、認証用の値は16バイト(Web Push の仕様)
    const bytes = (v: unknown) => (typeof v === 'string' ? Buffer.from(v, 'base64url').length : 0);
    if (bytes(sub.keys?.p256dh) !== 65 || bytes(sub.keys?.auth) !== 16) throw new Error('keys が正しくありません');
    const list = this.store.state.pushSubscriptions;
    const record: PushSubscriptionRecord = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, label: label.trim().slice(0, 40) || '端末', createdAt: now() };
    this.store.state.pushSubscriptions = [...list.filter((s) => s.endpoint !== sub.endpoint), record];
    this.store.changed();
    return record;
  }

  unsubscribe(endpoint: string): void {
    this.store.state.pushSubscriptions = this.store.state.pushSubscriptions.filter((s) => s.endpoint !== endpoint);
    this.store.changed();
  }

  async notifyApproval(a: ApprovalRequest): Promise<void> {
    const project = this.store.state.projects.find((p) => p.id === a.projectId);
    const business = this.store.state.businesses.find((b) => b.id === project?.businessId);
    const where = [business?.name, project?.name].filter(Boolean).join(' / ');
    await this.broadcast({
      title: `承認依頼 [${CATEGORY_LABEL[a.category]}]`,
      body: `${a.title}${where ? `\n${where}` : ''}`,
      tag: `approval-${a.id}`,
      url: '/',
      badge: this.store.state.approvals.filter((x) => x.status === 'pending').length,
    });
  }

  /** すべての端末に送る。期限切れ・解除済みの端末(404/410)は登録から外す。送れた件数を返す。 */
  async broadcast(payload: PushPayload): Promise<number> {
    const body = JSON.stringify(payload);
    const subs = [...this.store.state.pushSubscriptions];
    const results = await Promise.allSettled(subs.map((s) => this.send(s, body)));
    const gone = new Set<string>();
    let sent = 0;
    results.forEach((r, i) => {
      const sub = subs[i];
      if (r.status === 'fulfilled') sent++;
      else if ([404, 410].includes((r.reason as { statusCode?: number })?.statusCode ?? 0)) gone.add(sub.endpoint);
      else console.error(`通知の送信に失敗しました(${sub.label}):`, (r.reason as Error)?.message ?? r.reason);
    });
    if (gone.size) {
      this.store.state.pushSubscriptions = this.store.state.pushSubscriptions.filter((s) => !gone.has(s.endpoint));
      this.store.changed();
    }
    return sent;
  }
}
