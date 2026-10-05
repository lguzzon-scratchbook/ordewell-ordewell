import type { McpClientConfig } from '../mcp';

/**
 * OpenCode names an MCP tool `<server>_<tool>`, and keys its permission rules
 * by that name (checked against 1.18.34).
 */
export function ordewellToolPrefix(mcp: McpClientConfig): string {
  return `${mcp.name}_`;
}

/** Whether a permission request names one of the injected Ordewell server's tools. */
export function isOrdewellTool(mcp: McpClientConfig | null | undefined, permission: string | undefined): boolean {
  return !!mcp && !!permission && permission.startsWith(ordewellToolPrefix(mcp));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

/**
 * The `OPENCODE_CONFIG_CONTENT` for a process given the Ordewell server: the
 * remote server entry with its token header, and an allow rule so a call never
 * waits on a person (ADR-0022, S3). Deep-merged over `existing`, which a
 * terminal manifest or a workspace variable may already have set. Null when
 * `existing` is not a JSON object — it cannot be merged, and replacing it would
 * silently drop whatever it carried, so the caller runs without the server.
 */
export function mergeOrdewellConfig(existing: string | undefined, mcp: McpClientConfig): string | null {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(existing); } catch { return null; }
    if (!isRecord(parsed)) return null;
    base = parsed;
  }
  // A bare `"permission": "allow"` is the whole policy; the rule needs an object to join.
  const policy = typeof base.permission === 'string' ? { '*': base.permission } : base.permission;
  const ours = {
    mcp: { [mcp.name]: { type: 'remote', url: mcp.url, headers: mcp.headers, enabled: true } },
    permission: { [`${ordewellToolPrefix(mcp)}*`]: 'allow' },
  };
  return JSON.stringify(deepMerge({ ...base, ...(policy === undefined ? {} : { permission: policy }) }, ours));
}
