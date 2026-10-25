// Provider adapter (W8.1): model calls sit behind ModelProvider so a second provider can be added later.

import { claudeRunner, type AgentRequest, type AgentResult, type Runner } from './agent.ts';

export interface ModelProvider {
  name: string;
  run(req: AgentRequest): Promise<AgentResult>;
}

export function makeClaudeProvider(runner: Runner = claudeRunner): ModelProvider {
  return { name: 'claude', run: (req) => runner(req) };
}

export function resolveProvider(name?: string, runner?: Runner): ModelProvider {
  if (name === undefined || name === 'claude') return makeClaudeProvider(runner);
  throw new Error(`unknown model provider "${name}" (supported: claude)`);
}
