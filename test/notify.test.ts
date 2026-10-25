import { test } from 'node:test';
import { createECDH, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { Approvals } from '../src/core/approvals.ts';
import { PushNotifier, type PushPayload } from '../src/core/notify.ts';
import { Store } from '../src/core/store.ts';
import type { PushSubscriptionRecord } from '../src/core/types.ts';

const keys = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') };
};
const sub = (n: number) => ({ endpoint: `https://push.example.com/${n}`, keys: keys() });

function setup(fail: Record<string, number> = {}) {
  const store = new Store();
  const approvals = new Approvals(store);
  const sent: Array<{ to: string; payload: PushPayload }> = [];
  const send = async (s: PushSubscriptionRecord, body: string) => {
    if (fail[s.endpoint]) throw Object.assign(new Error('push failed'), { statusCode: fail[s.endpoint] });
    sent.push({ to: s.endpoint, payload: JSON.parse(body) });
  };
  const push = new PushNotifier(store, approvals, { publicKey: 'p', privateKey: 'k', subject: 'mailto:a@example.com' }, send);
  return { store, approvals, push, sent };
}

test('承認依頼が出ると、登録済みの全端末に通知する', async () => {
  const { store, approvals, push, sent } = setup();
  store.state.businesses.push({ id: 'b1', name: '朝食事業' } as never);
  store.state.projects.push({ id: 'p1', name: 'LP制作', businessId: 'b1' } as never);
  push.subscribe(sub(1), 'iPad');
  push.subscribe(sub(2), 'iPhone');
  approvals.request({ projectId: 'p1', kind: 'task_gate', category: 'publish', title: 'LPを公開', detail: '秘密の詳細', requestedBy: 'web_developer' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent.map((s) => s.to), [sub(1).endpoint, sub(2).endpoint]);
  const p = sent[0].payload;
  assert.equal(p.title, '承認依頼 [外部公開]');
  assert.match(p.body, /LPを公開\n朝食事業 \/ LP制作/);
  assert.doesNotMatch(p.body, /秘密の詳細/, 'ロック画面に出るので詳細は載せない');
  assert.equal(p.badge, 1);
});

test('解除済みの端末(410)は登録から外し、一時的な失敗は残す', async () => {
  const { store, push } = setup({ [sub(1).endpoint]: 410, [sub(2).endpoint]: 500 });
  push.subscribe(sub(1), 'old');
  push.subscribe(sub(2), 'flaky');
  push.subscribe(sub(3), 'ok');
  const sent = await push.broadcast({ title: 't', body: 'b', tag: 't', url: '/', badge: 0 });
  assert.equal(sent, 1);
  assert.deepEqual(store.state.pushSubscriptions.map((s) => s.label), ['flaky', 'ok']);
});

test('同じ端末の再登録は上書きし、不正な購読情報は拒否する', () => {
  const { store, push } = setup();
  push.subscribe(sub(1), 'iPad');
  push.subscribe(sub(1), 'iPad(更新)');
  assert.deepEqual(store.state.pushSubscriptions.map((s) => s.label), ['iPad(更新)']);
  assert.throws(() => push.subscribe({ endpoint: 'http://insecure.example.com', keys: sub(1).keys }, 'x'), /https/);
  assert.throws(() => push.subscribe({ endpoint: 'https://ok.example.com', keys: { p256dh: '', auth: '' } }, 'x'), /keys/);
  assert.throws(() => push.subscribe({ endpoint: 'https://ok.example.com', keys: { p256dh: 'BPfake', auth: 'authfake' } }, 'x'), /keys/);
  push.unsubscribe(sub(1).endpoint);
  assert.equal(store.state.pushSubscriptions.length, 0);
});
