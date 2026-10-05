import { bearerHeaderValue } from '../../utils/daemonToken';
import type { McpCredential } from './OrdewellMcpServer';

/** The server's name in every runner's MCP configuration, and so in its tool names (`mcp__ordewell__*`). */
export const ORDEWELL_MCP_SERVER_NAME = 'ordewell';

export interface McpClientConfig {
  name: typeof ORDEWELL_MCP_SERVER_NAME;
  url: string;
  headers: Record<string, string>;
}

/**
 * The one shape every runner adapter renders its own MCP configuration from.
 * The token travels only in `headers`: the adapter writes it to an owner-only
 * file or an environment variable, never a prompt or a process argument
 * (ADR-0022, A4/A5).
 */
export function mcpClientConfig(credential: McpCredential): McpClientConfig {
  return {
    name: ORDEWELL_MCP_SERVER_NAME,
    url: credential.url,
    headers: { Authorization: bearerHeaderValue(credential.token) },
  };
}
