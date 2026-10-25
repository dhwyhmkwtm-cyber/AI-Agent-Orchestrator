import type { ApprovalCategory } from '../core/types.ts';

export interface RiskAssessment {
  category: ApprovalCategory;
  reason: string;
}

// 外部に公開する・外部の状態を変える・費用が発生しうるコマンド。
const BASH_RULES: Array<{ pattern: RegExp; category: ApprovalCategory; reason: string }> = [
  { pattern: /\bgit\s+push\b/, category: 'publish', reason: 'リモートリポジトリへのpush' },
  { pattern: /\b(npm|pnpm|yarn)\s+publish\b/, category: 'publish', reason: 'パッケージの公開' },
  { pattern: /\b(vercel|netlify|firebase|wrangler|flyctl|heroku|surge)\b/, category: 'publish', reason: 'ホスティングサービスへのデプロイ' },
  { pattern: /\bdeploy\b/i, category: 'publish', reason: 'デプロイ操作' },
  { pattern: /\bgh\s+(pr|release|repo|issue)\s+(create|edit|merge|delete)\b/, category: 'publish', reason: 'GitHub上への公開・変更' },
  { pattern: /\b(aws|gcloud|az|terraform|pulumi|kubectl|doctl)\b/, category: 'cost', reason: 'クラウドリソースの操作(費用が発生しうる)' },
  { pattern: /\bstripe\b/, category: 'cost', reason: '決済サービスの操作' },
  { pattern: /\bcurl\b.*(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s|-F\s|--form)/i, category: 'publish', reason: '外部サービスへのデータ送信' },
  { pattern: /\b(wget|curl)\b.*\|\s*(ba)?sh\b/, category: 'decision', reason: 'ダウンロードしたスクリプトの実行' },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/, category: 'decision', reason: '広範囲のファイル削除' },
  { pattern: /\b(sudo|ssh|scp)\b/, category: 'decision', reason: '特権操作・リモートホストへの接続' },
];

/**
 * ツール呼び出しを分類する。承認が必要なら理由を返し、不要なら null。
 * 判定に迷うもの(未知のMCPツール)は承認側に倒す。
 */
export function assessToolUse(toolName: string, input: Record<string, unknown>): RiskAssessment | null {
  if (toolName === 'Bash') {
    const command = String(input.command ?? '');
    for (const rule of BASH_RULES) {
      if (rule.pattern.test(command)) return { category: rule.category, reason: rule.reason };
    }
    return null;
  }
  if (toolName.startsWith('mcp__')) {
    return { category: 'decision', reason: `外部連携ツール ${toolName} の実行` };
  }
  return null;
}
