import { query, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { assessToolUse } from '../policy/risk.ts';
import type { AgentProvider, AgentRunRequest, AgentRunResult } from './types.ts';

// 品質を優先して Opus を既定にする。費用を抑えたい役割は、役割定義の model で Sonnet などに下げる。
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_EFFORT = 'medium';

/** ツール入力をログ用に短くまとめる。 */
function describeToolInput(name: string, input: Record<string, unknown>): string {
  const value = input.command ?? input.file_path ?? input.url ?? input.query ?? input.pattern ?? '';
  return `${name} ${String(value)}`.slice(0, 200);
}

/**
 * Claude Code(Claude Agent SDK)で役割を実行するプロバイダ。
 * - 役割ごとに使えるツールを tools で制限する
 * - 危険なツール操作は canUseTool で止め、人間の承認を待つ
 * - 最終出力は outputFormat(JSONスキーマ)で構造化して受け取る
 */
export class ClaudeCodeProvider implements AgentProvider {
  readonly id = 'claude-code';

  constructor(private readonly defaultModel = process.env.CLAUDE_MODEL ?? DEFAULT_MODEL) {}

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const canUseTool: CanUseTool = async (toolName, input, { blockedPath }) => {
      if (blockedPath) {
        return { behavior: 'deny', message: `ワークスペース外へのアクセスは禁止されています: ${blockedPath}` };
      }
      const risk = assessToolUse(toolName, input);
      if (!risk) return { behavior: 'allow', updatedInput: input };
      req.onProgress(`⏸ 承認待ち: ${risk.reason}`);
      const decision = await req.requestApproval({
        category: risk.category,
        title: `${req.role.name}: ${risk.reason}`,
        detail: describeToolInput(toolName, input),
      });
      if (decision.approved) return { behavior: 'allow', updatedInput: input };
      return {
        behavior: 'deny',
        message: `人間が却下しました${decision.comment ? `: ${decision.comment}` : ''}。この操作を行わずに作業を続けてください。`,
      };
    };

    const abortController = new AbortController();
    req.signal?.addEventListener('abort', () => abortController.abort());

    const q = query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        model: req.role.model ?? this.defaultModel,
        effort: req.role.effort ?? DEFAULT_EFFORT,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: req.systemPrompt },
        tools: req.role.tools,
        outputFormat: { type: 'json_schema', schema: req.outputSchema },
        permissionMode: 'default',
        canUseTool,
        maxBudgetUsd: req.maxBudgetUsd,
        abortController,
        // ユーザー・プロジェクトの設定ファイルに左右されないようにする
        settingSources: [],
        persistSession: false,
      },
    });

    for await (const message of q) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            req.onProgress(block.text.trim().slice(0, 300));
          } else if (block.type === 'tool_use') {
            req.onProgress(`🔧 ${describeToolInput(block.name, block.input as Record<string, unknown>)}`);
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error) {
          const reason = message.subtype === 'success' ? message.result : message.errors.join('; ') || message.subtype;
          throw new Error(`Claude Code の実行に失敗しました: ${reason}`);
        }
        if (message.structured_output === undefined) {
          throw new Error('Claude Code が構造化出力を返しませんでした');
        }
        return { output: message.structured_output, costUsd: message.total_cost_usd };
      }
    }
    throw new Error('Claude Code が結果を返さずに終了しました');
  }
}
