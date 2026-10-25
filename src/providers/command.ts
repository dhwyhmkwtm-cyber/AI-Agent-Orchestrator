import { spawn } from 'node:child_process';
import type { AgentProvider, AgentRunRequest, AgentRunResult } from './types.ts';

/** 標準出力から最後のJSONオブジェクトを取り出す。 */
export function extractLastJson(text: string): unknown {
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    for (let start = text.lastIndexOf('{', end); start >= 0; start = text.lastIndexOf('{', start - 1)) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // より外側の { を試す
      }
    }
  }
  throw new Error('出力にJSONが見つかりません');
}

/**
 * 任意のCLI型AIエージェント(Codex CLI など)を呼び出す汎用プロバイダ。
 * プロンプトを標準入力に渡し、標準出力の最後のJSONを結果とする。
 *
 * 注意: このプロバイダはツール単位の承認(canUseTool)を挟めない。
 * 呼び出すCLI側のサンドボックス・承認設定で、外部公開や費用発生の操作ができないようにしておくこと。
 */
export class CommandProvider implements AgentProvider {
  constructor(
    readonly id: string,
    private readonly command: string,
    private readonly args: string[] = [],
  ) {}

  run(req: AgentRunRequest): Promise<AgentRunResult> {
    const input = [
      req.systemPrompt,
      '',
      req.prompt,
      '',
      '最後に、次のJSONスキーマに従うJSONオブジェクトだけを出力してください:',
      JSON.stringify(req.outputSchema),
    ].join('\n');

    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, { cwd: req.cwd, signal: req.signal });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk;
        const line = chunk.toString().trim().split('\n').pop();
        if (line) req.onProgress(line.slice(0, 300));
      });
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`${this.command} が終了コード ${code} で失敗: ${stderr.slice(-500)}`));
        try {
          resolve({ output: extractLastJson(stdout), costUsd: 0 });
        } catch (err) {
          reject(err);
        }
      });
      child.stdin.end(input);
    });
  }
}
