import { withPath } from '../../utils/shellPath';

/**
 * Host variables a runner must not inherit. A host started from inside a
 * Claude Code session carries `CLAUDECODE`, which a runner's `claude` reads as
 * being nested in that session, and a host being debugged carries Node flags
 * that every Node-based runner would pick up as its own.
 */
export const HOST_ONLY_VARIABLES: readonly string[] = ['CLAUDECODE', 'NODE_OPTIONS', 'NODE_INSPECT', 'NODE_DEBUG'];
const HOST_ONLY = new Set(HOST_ONLY_VARIABLES);

/**
 * The environment a runner process is spawned under: the host's,
 * minus {@link HOST_ONLY}, then `overrides` — the workspace's own variables
 * (ADR-0016) among them, which still win if they set one on purpose.
 */
export function runnerEnv(resolvedPath: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const host: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Windows variable names are case-insensitive.
    if (!HOST_ONLY.has(key.toUpperCase())) host[key] = value;
  }
  return withPath(host, resolvedPath, overrides);
}
