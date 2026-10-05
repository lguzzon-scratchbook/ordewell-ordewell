import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { extractPresentedToken } from '../../utils/daemonToken';
import { PLANNER_TOOLS, TASK_TOOLS, type McpTool, type PlannerToolHandler, type TaskToolHandler } from './tools';

/**
 * The Ordewell MCP server (ADR-0022): one loopback listener per process,
 * shared by every session in it, where the caller's token alone decides which
 * tools it sees and which session and task its calls reach.
 */

export const ORDEWELL_MCP_PATH = '/mcp';

export interface TaskTokenScope {
  sessionId: string;
  taskId: string;
  /** The attempt generation the token is good for; a later attempt gets a new token. */
  attempt: number;
}

export interface PlannerTokenScope {
  sessionId: string;
}

/** Where a runner reaches the server and what it presents there. Never put either half in a prompt. */
export interface McpCredential {
  url: string;
  token: string;
}

type Grant =
  | { role: 'task'; scope: TaskTokenScope; handler: TaskToolHandler; revoked: AbortController }
  | { role: 'planner'; scope: PlannerTokenScope; handler: PlannerToolHandler; revoked: AbortController };

export class OrdewellMcpServer {
  private readonly grants = new Map<string, Grant>();
  private http: Server | undefined;
  private listening: Promise<string> | undefined;
  private boundUrl: string | undefined;
  private boundHost: string | undefined;

  /** The listener's URL, once the first token has started it. */
  get url(): string | undefined {
    return this.boundUrl;
  }

  issueTaskToken(scope: TaskTokenScope, handler: TaskToolHandler = {}): Promise<McpCredential> {
    return this.issue({ role: 'task', scope: { ...scope }, handler, revoked: new AbortController() });
  }

  issuePlannerToken(scope: PlannerTokenScope, handler: PlannerToolHandler = {}): Promise<McpCredential> {
    return this.issue({ role: 'planner', scope: { ...scope }, handler, revoked: new AbortController() });
  }

  /** Refuse every later request carrying `token`, and abort the calls it has in flight. */
  revoke(token: string): void {
    const grant = this.grants.get(token);
    if (!grant) return;
    this.grants.delete(token);
    grant.revoked.abort();
  }

  async dispose(): Promise<void> {
    for (const token of [...this.grants.keys()]) this.revoke(token);
    const http = this.http;
    this.http = undefined;
    this.listening = undefined;
    this.boundUrl = undefined;
    this.boundHost = undefined;
    if (!http) return;
    // A checkpoint call holds its response open for as long as a person takes
    // to answer; close() alone would wait on it.
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  private async issue(grant: Grant): Promise<McpCredential> {
    const url = await this.start();
    const token = randomBytes(32).toString('base64url');
    this.grants.set(token, grant);
    return { url, token };
  }

  private start(): Promise<string> {
    this.listening ??= new Promise<string>((resolve, reject) => {
      const http = createServer((req, res) => {
        this.handle(req, res).catch(() => {
          if (!res.headersSent) reply(res, 500, 'Internal error');
          else res.destroy();
        });
      });
      http.once('error', (err) => {
        this.listening = undefined;
        reject(err);
      });
      http.listen(0, '127.0.0.1', () => {
        const address = http.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('Ordewell MCP server bound to no TCP port'));
          return;
        }
        this.boundHost = `127.0.0.1:${address.port}`;
        this.boundUrl = `http://${this.boundHost}${ORDEWELL_MCP_PATH}`;
        resolve(this.boundUrl);
      });
      // The listener serves the sessions in this process; it should never be
      // the reason the process stays alive after they are gone.
      http.unref();
      this.http = http;
    });
    return this.listening;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a web page can make the browser send to this port under a
    // hostname it controls, but it cannot forge Host or drop Origin (ADR-0022, T2).
    if (req.headers.host !== this.boundHost || req.headers.origin !== undefined) {
      reply(res, 403, 'Forbidden');
      return;
    }
    const token = extractPresentedToken({ authorization: req.headers.authorization });
    const grant = token === undefined ? undefined : this.grants.get(token);
    if (!grant) {
      reply(res, 401, 'Unauthorized');
      return;
    }
    if (new URL(req.url ?? '/', `http://${this.boundHost}`).pathname !== ORDEWELL_MCP_PATH) {
      reply(res, 404, 'Not found');
      return;
    }

    // Stateless: a fresh server per request, built from the grant, so the tool
    // list and every call are fixed by the token on that very request.
    const mcp = new McpProtocolServer({ name: 'ordewell', version: '1' }, { capabilities: { tools: {} } });
    if (grant.role === 'task') serveTools(mcp, TASK_TOOLS, grant.handler, grant.revoked.signal);
    else serveTools(mcp, PLANNER_TOOLS, grant.handler, grant.revoked.signal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  }
}

function serveTools<H>(mcp: McpProtocolServer, tools: readonly McpTool<H>[], handler: H, revoked: AbortSignal): void {
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })),
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    try {
      const result = await tool.call(handler, request.params.arguments, { signal: AbortSignal.any([revoked, extra.signal]) });
      return { content: [{ type: 'text', text: result.text }], isError: result.isError ?? false };
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  });
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' }).end(message);
}

let shared: OrdewellMcpServer | undefined;

/** The process's one server, which the daemon and the extension host hand to every session they build. */
export function sharedMcpServer(): OrdewellMcpServer {
  shared ??= new OrdewellMcpServer();
  return shared;
}
