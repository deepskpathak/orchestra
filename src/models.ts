// Model-agnostic roles: harness config may name a tier (strong, balanced, fast) instead of a model.
// A tier resolves to a concrete model id through the capability table for a provider.
// Any other string is treated as a literal model name and passed through unchanged.

import type { Role } from './types.ts';

export type Tier = 'strong' | 'balanced' | 'fast';
export const TIERS: Tier[] = ['strong', 'balanced', 'fast'];
export const DEFAULT_PROVIDER = 'anthropic';

export interface Capability {
  model: string;
  contextTokens: number;
  cacheMinTokens: number;
}

// Context and cache figures are approximate and must be re-checked against provider docs.
// Prices are deliberately absent. Add them only from the provider's published price list.
export const CAPABILITIES: Record<string, Record<Tier, Capability>> = {
  anthropic: {
    strong: { model: 'opus', contextTokens: 200_000, cacheMinTokens: 1024 },
    balanced: { model: 'sonnet', contextTokens: 200_000, cacheMinTokens: 1024 },
    fast: { model: 'haiku', contextTokens: 200_000, cacheMinTokens: 2048 },
  },
};

export function isTier(v: unknown): v is Tier {
  return typeof v === 'string' && (TIERS as string[]).includes(v);
}

export function resolveModel(value: string, provider = DEFAULT_PROVIDER, table = CAPABILITIES): string {
  if (!isTier(value)) return value;
  const caps = Object.hasOwn(table, provider) ? table[provider] : undefined;
  if (!caps) throw new Error(`Unknown provider "${provider}" for tier "${value}". Known providers: ${Object.keys(table).join(', ')}`);
  return caps[value].model;
}

export function resolveModels(models: Record<Role, string>, provider = DEFAULT_PROVIDER, table = CAPABILITIES): Record<Role, string> {
  const out = {} as Record<Role, string>;
  for (const role of Object.keys(models) as Role[]) out[role] = resolveModel(models[role], provider, table);
  return out;
}
