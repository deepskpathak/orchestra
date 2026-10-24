// PreToolUse guard injected into every agent session. Hard rules, enforced by the harness
// rather than by prompt: holdout scenarios stay hidden, no network, no publishing, no secrets.

export interface GuardDecision {
  allow: boolean;
  reason?: string;
}

const NETWORK = /\b(curl|wget|ssh|scp|rsync|nc|telnet|ftp)\b|\bgit\s+push\b|\bnpm\s+publish\b|\bgh\s+(pr|release|repo)\s+create\b/;
const READ_ONLY = new Set(['Read', 'Grep', 'Glob']);
const SECRET_PATH = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|\.npmrc|\.netrc|credentials(\.json)?|.*\.pem|.*\.key)$/;

export function decide(toolName: string, input: Record<string, unknown>): GuardDecision {
  const blob = JSON.stringify(input ?? {});
  if (/\.orchestra\/holdout|\.orchestra\\\\holdout/.test(blob)) return { allow: false, reason: 'Holdout scenarios are visible to the judge only.' };
  if (/\.orchestra\/(harness|evals|archive\.json)/.test(blob) && toolName !== 'Read' && toolName !== 'Grep' && toolName !== 'Glob') {
    return { allow: false, reason: 'Agents may not modify the harness, evals, or archive.' };
  }
  if (/(^|[\/"'\s])scorer(\/|\\|["'\s]|$)/.test(blob.replace(/\\\\/g, '/')) && !READ_ONLY.has(toolName)) {
    return { allow: false, reason: 'Agents may not modify the frozen scorer.' };
  }
  if (toolName === 'Bash') {
    const cmd = String(input?.command ?? '');
    if (NETWORK.test(cmd)) return { allow: false, reason: 'Network access and publishing are disabled inside Orchestra.' };
  }
  const path = String(input?.file_path ?? input?.path ?? '');
  if (path && SECRET_PATH.test(path)) return { allow: false, reason: 'Secret files are off limits.' };
  return { allow: true };
}

export async function guardMain(): Promise<void> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload: { tool_name?: string; tool_input?: Record<string, unknown> } = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    // Malformed hook input: fail closed for safety.
    process.stderr.write('orchestra guard: unreadable hook input');
    process.exit(2);
  }
  const d = decide(payload.tool_name ?? '', payload.tool_input ?? {});
  if (!d.allow) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `orchestra guard: ${d.reason}` } }),
    );
  }
  process.exit(0);
}
