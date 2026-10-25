import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import webpush from 'web-push';

export interface Secrets {
  /** 外部サービスがKPIの値を送ってくるときのトークン。ダッシュボードのログイントークンとは分ける。 */
  ingestToken: string;
  /** Web Push の署名鍵(VAPID)。変えると登録済みの端末に届かなくなるので、一度作ったら保存して使い続ける。 */
  vapid: { publicKey: string; privateKey: string };
}

/** data/secrets.json を読み、足りない値は作って保存する。環境変数が優先。 */
export function loadSecrets(dataDir?: string): Secrets {
  const path = dataDir ? join(dataDir, 'secrets.json') : undefined;
  const saved: Partial<Secrets> = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const secrets: Secrets = {
    ...saved,
    ingestToken: saved.ingestToken ?? randomBytes(24).toString('base64url'),
    vapid: saved.vapid ?? webpush.generateVAPIDKeys(),
  };
  if (path && JSON.stringify(saved) !== JSON.stringify(secrets)) {
    writeFileSync(path, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  }
  if (process.env.INGEST_TOKEN) secrets.ingestToken = process.env.INGEST_TOKEN;
  return secrets;
}
