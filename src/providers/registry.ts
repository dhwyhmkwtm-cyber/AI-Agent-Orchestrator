import { ClaudeCodeProvider } from './claude-code.ts';
import { CommandProvider } from './command.ts';
import { MockProvider, demoHandler } from './mock.ts';
import type { AgentProvider } from './types.ts';

export class ProviderRegistry {
  private providers = new Map<string, AgentProvider>();

  register(provider: AgentProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): AgentProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`provider not registered: ${id}`);
    return provider;
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }
}

/**
 * 環境変数からプロバイダを組み立てる。
 * - PROVIDER=mock … すべての役割をモックで動かす(デモ)
 * - COMMAND_PROVIDERS='{"codex":{"command":"codex","args":["exec","-"]}}' … CLI型エージェントを追加
 */
export function createRegistryFromEnv(env = process.env): { registry: ProviderRegistry; override?: string } {
  const registry = new ProviderRegistry();
  registry.register(new ClaudeCodeProvider());
  registry.register(new MockProvider(demoHandler, Number(env.DEMO_DELAY_MS ?? 1500)));
  if (env.COMMAND_PROVIDERS) {
    const defs = JSON.parse(env.COMMAND_PROVIDERS) as Record<string, { command: string; args?: string[] }>;
    for (const [id, def] of Object.entries(defs)) registry.register(new CommandProvider(id, def.command, def.args));
  }
  return { registry, override: env.PROVIDER || undefined };
}
