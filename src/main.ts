import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { Approvals } from './core/approvals.ts';
import { Orchestrator } from './core/orchestrator.ts';
import { Store } from './core/store.ts';
import { createRegistryFromEnv } from './providers/registry.ts';
import { DEFAULT_ROLES } from './roles/catalog.ts';
import { createDashboardServer } from './server/http.ts';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const dataDir = resolve(process.env.DATA_DIR ?? join(root, 'data'));
const workspaceRoot = resolve(process.env.WORKSPACE_DIR ?? join(root, 'workspaces'));
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
const token = process.env.DASHBOARD_TOKEN || randomBytes(18).toString('base64url');

const store = new Store(dataDir);
const approvals = new Approvals(store);
const { registry, override } = createRegistryFromEnv();
const orchestrator = new Orchestrator({
  store,
  approvals,
  providers: registry,
  roles: DEFAULT_ROLES,
  workspaceRoot,
  providerOverride: override,
  maxParallel: Number(process.env.MAX_PARALLEL ?? 2),
  maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 3),
  maxReviewers: Number(process.env.MAX_REVIEWERS ?? 1),
});

const server = createDashboardServer({
  store,
  approvals,
  orchestrator,
  publicDir: join(root, 'public'),
  workspaceRoot,
  token,
});

server.listen(port, host, () => {
  const hosts = host === '0.0.0.0'
    ? Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address)
    : [host];
  console.log(`AI Agent Orchestrator を起動しました (provider: ${override ?? 'roles default'})`);
  for (const h of hosts) console.log(`  ダッシュボード: http://${h}:${port}/login?token=${token}`);
  if (!process.env.DASHBOARD_TOKEN) console.log('  ※ トークンは起動ごとに変わります。固定するには DASHBOARD_TOKEN を設定してください。');
  orchestrator.resume();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    store.flush();
    process.exit(0);
  });
}
