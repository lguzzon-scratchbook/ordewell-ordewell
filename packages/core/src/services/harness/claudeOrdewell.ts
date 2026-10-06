import { ownerOnlyConfigFile, type McpClientConfig, type OwnerOnlyFile } from '../mcp';
import { MCP_CLIENT_TOOL_NAMES, type OrdewellToolBinding, type OrdewellToolRole } from './ordewellBinding';

/** What Claude Code is launched with to reach the server: its arguments, and the file they name. */
export interface ClaudeOrdewellLaunch {
  args: string[];
  /** Holds the token; the caller removes it once the process that reads it is gone. */
  config: OwnerOnlyFile;
}

export interface ClaudeOrdewellBinding extends OrdewellToolBinding<string> {
  launch(mcp: McpClientConfig, role: OrdewellToolRole): ClaudeOrdewellLaunch;
}

export const CLAUDE_ORDEWELL: ClaudeOrdewellBinding = {
  toolName: MCP_CLIENT_TOOL_NAMES.toolName,
  toolNames: MCP_CLIENT_TOOL_NAMES.toolNames,
  /** `can_use_tool`'s `tool_name`. */
  isOrdewellAsk: (toolName: string) => MCP_CLIENT_TOOL_NAMES.hasPrefix(toolName),
  /** `mcp_status` reports `pending` until the CLI's connection attempt settles. */
  attachState: (status) => (status === 'connected' ? 'connected' : status === 'pending' ? 'pending' : 'failed'),

  /**
   * `--mcp-config` takes a path as well as inline JSON; the path keeps the
   * token out of the argv every local user can list (ADR-0022, A5).
   * `alwaysLoad` because the CLI otherwise defers MCP tools behind its tool
   * search, and a model that has to look an Ordewell tool up first tends to
   * go on without it.
   */
  launch(mcp: McpClientConfig, role: OrdewellToolRole): ClaudeOrdewellLaunch {
    const config = ownerOnlyConfigFile('mcp.json', JSON.stringify({
      mcpServers: { [mcp.name]: { type: 'http', url: mcp.url, headers: mcp.headers, alwaysLoad: true } },
    }));
    return { args: ['--mcp-config', config.path, '--allowedTools', MCP_CLIENT_TOOL_NAMES.toolNames(role).join(',')], config };
  },
};
