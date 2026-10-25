// 通知を受け取るためのサービスワーカー。iPad ではホーム画面に追加したアプリから登録したときだけ動く。

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'AI Agent Orchestrator', body: event.data?.text() ?? '' };
  }
  const jobs = [
    self.registration.showNotification(data.title || 'AI Agent Orchestrator', {
      body: data.body || '',
      tag: data.tag,
      data: { url: data.url || '/' },
      icon: '/icon-192.png',
      badge: '/badge-96.png',
    }),
  ];
  if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
    jobs.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
  }
  event.waitUntil(Promise.all(jobs).catch(() => {}));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => w.url.startsWith(self.location.origin));
    if (open) return open.focus();
    return self.clients.openWindow(url);
  })());
});
