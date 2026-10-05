import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { OrdewellMcpServer } from '../mcp';
import type { ConversationRequest } from '../AiService';
import type { SessionRuntimeSettings } from '../createSession';
import type { SessionMessage } from '../SessionMessage';
import type { DiscoveredModel } from '../../models/Task';
import { makeSession } from './sessionTestKit';
import { buildConversationSystemPrompt } from '../PlanPrompts';
import { runnerModesFrom } from '../ModeResolver';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, fakeFileSystem } from '../../testing';
import { respondingSpawn, type FakeAgentProcess, type FakeSpawnResult } from './harnessTestKit';

/**
 * The Ordewell MCP server reaching the Claude Code planner (ADR-0022): the
 * fake `claude` reads the `--mcp-config` file it was spawned with and calls
 * the real server over HTTP, the way the CLI does.
 */

const servers: OrdewellMcpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.dispose()));
});

function newServer(): OrdewellMcpServer {
  const server = new OrdewellMcpServer();
  servers.push(server);
  return server;
}

interface InjectedServer {
  url: string;
  headers: Record<string, string>;
}

function injectedServer(args: string[]): InjectedServer | null {
  const at = args.indexOf('--mcp-config');
  if (at < 0) return null;
  const config = JSON.parse(readFileSync(args[at + 1], 'utf8')) as { mcpServers: Record<string, InjectedServer> };
  return config.mcpServers.ordewell;
}

async function connectAs(args: string[]): Promise<Client> {
  const injected = injectedServer(args);
  if (!injected) throw new Error('spawned without the Ordewell server');
  const client = new Client({ name: 'fake-claude', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(injected.url), { requestInit: { headers: injected.headers } }));
  clients.push(client);
  return client;
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

function reply(proc: FakeAgentProcess, text: string): void {
  proc.emitStdout(line({ type: 'system', subtype: 'init', session_id: 'sess-1', permissionMode: 'plan' }));
  proc.emitStdout(line({ type: 'assistant', session_id: 'sess-1', message: { id: 'm1', content: [{ type: 'text', text }] } }));
  proc.emitStdout(line({ type: 'result', subtype: 'success', session_id: 'sess-1', is_error: false, result: text }));
}

interface FakeClaude {
  /** What the CLI's own `mcp_status` reports for the Ordewell server. */
  status?: 'connected' | 'failed';
  /** One user turn: what it does with the injected server (absent when none was injected), and the reply text. */
  turn?: (mcp: Client | null, message: string) => Promise<string>;
}

function fakeClaude({ status = 'connected', turn = async () => 'What should it do?' }: FakeClaude = {}): FakeSpawnResult {
  return respondingSpawn((written, proc, args) => {
    const msg = JSON.parse(written) as { type: string; request_id?: string; request?: { subtype?: string }; message?: { content: { text: string }[] } };
    if (msg.type === 'control_request' && msg.request?.subtype === 'mcp_status') {
      const mcpServers = injectedServer(args) ? [{ name: 'ordewell', status }] : [];
      proc.emitStdout(line({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mcpServers } } }));
      return;
    }
    if (msg.type !== 'user') return;
    void (async () => {
      const mcp = injectedServer(args) && status === 'connected' ? await connectAs(args) : null;
      return turn(mcp, msg.message?.content[0]?.text ?? '');
    })().then(
      (text) => reply(proc, text),
      (err: unknown) => reply(proc, `The fake planner failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  });
}

function service(spawned: FakeSpawnResult, mcpServer?: OrdewellMcpServer) {
  return new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code' }), {
    spawn: spawned.spawn,
    resolvePath: async () => '/usr/bin',
    workspaceRoot: () => '/repo',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    mcpServer,
  });
}

function request(overrides: Partial<ConversationRequest> = {}): ConversationRequest {
  return {
    goal: 'Add a cache layer',
    runners: ['claude-code'],
    modelsByRunner: { 'claude-code': [{ modelId: 'sonnet', modelLabel: 'Sonnet', variants: [] }] },
    fs: fakeFileSystem(),
    onProgress: () => {},
    plannerTools: { sessionId: 's1', handler: {} },
    ...overrides,
  };
}

function bearer(server: InjectedServer): string {
  return server.headers.Authorization.replace(/^Bearer /, '');
}

describe('the Claude Code planner with the Ordewell server injected', () => {
  it('reaches it through an owner-only config file, its tools pre-allowed by name, the token never on the command line', async () => {
    const server = newServer();
    const spawned = fakeClaude();
    await service(spawned, server).startConversation(request());

    const args = spawned.lastArgs();
    const configPath = args[args.indexOf('--mcp-config') + 1];
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const injected = injectedServer(args)!;
    expect(injected.url).toBe(server.url);
    expect(args.join(' ')).not.toContain(bearer(injected));
    expect(args[args.indexOf('--allowedTools') + 1].split(',')).toEqual([
      'mcp__ordewell__list_runners', 'mcp__ordewell__list_models', 'mcp__ordewell__submit_plan',
      'mcp__ordewell__edit_plan', 'mcp__ordewell__task_query', 'mcp__ordewell__task_output',
    ]);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
  });
});

describe('the planner token', () => {
  it('is refused, and its config file gone, once the session resets', async () => {
    const server = newServer();
    const spawned = fakeClaude();
    const svc = service(spawned, server);
    await svc.startConversation(request());
    const args = spawned.lastArgs();
    const configPath = args[args.indexOf('--mcp-config') + 1];
    const client = await connectAs(args);

    svc.reset();

    expect(existsSync(configPath)).toBe(false);
    await expect(client.listTools()).rejects.toThrow(/Unauthorized/);
  });
});

describe('a planner the server did not reach', () => {
  it('is respawned with today\'s prompt and no server when the CLI reports the connection failed', async () => {
    const server = newServer();
    const withTools = fakeClaude({ status: 'failed' });
    const svc = service(withTools, server);
    await svc.startConversation(request());

    const without = fakeClaude();
    await service(without).startConversation(request());

    expect(withTools.processes).toHaveLength(2);
    expect(withTools.processes[0].killed).toBe(true);
    expect(withTools.lastArgs()).toEqual(without.lastArgs());
    expect(svc.plannerToolsAttached()).toBe(false);
  });

  it('is spawned exactly as before when the session has no server to offer', async () => {
    const spawned = fakeClaude();
    const svc = service(spawned);
    await svc.startConversation(request());

    expect(spawned.lastArgs()).not.toContain('--mcp-config');
    expect(spawned.lastArgs()).not.toContain('--allowedTools');
    expect(svc.plannerToolsAttached()).toBe(false);
  });
});

/** A planning session on a real harness planner, whose settings the test rewrites the way a settings write would. */
function plannerSession(claude: FakeSpawnResult, initial: Partial<SessionRuntimeSettings> = {}, { inject = true } = {}) {
  const server = newServer();
  let settings: SessionRuntimeSettings = { tddEnabled: false, enabledRunners: ['claude-code'], ...initial };
  const ai = service(claude, inject ? server : undefined);
  const broadcast = vi.fn<(msg: SessionMessage) => void>();
  const session = makeSession({
    aiService: ai,
    mcpServer: server,
    modelResolver: {
      modelsForRunners: vi.fn(async (runners: string[]) => Object.fromEntries(runners.map((r) => [r, CATALOG[r] ?? []]))),
    },
    settings: () => settings,
    broadcast,
  });
  return {
    session,
    ai,
    broadcast,
    settings: (change: Partial<SessionRuntimeSettings>) => { settings = { ...settings, ...change }; },
  };
}

const CATALOG: Record<string, DiscoveredModel[]> = {
  'claude-code': [
    { modelId: 'claude-sonnet-4', modelLabel: 'Claude Sonnet 4', variants: [] },
    { modelId: 'claude-opus-4', modelLabel: 'Claude Opus 4', variants: [{ id: 'high', label: 'High' }] },
  ],
  codex: [{ modelId: 'gpt-5', modelLabel: 'GPT-5', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] }],
};

async function call(mcp: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: unknown }> {
  const result = await mcp.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, body: JSON.parse(first.text) };
}

describe('list_runners and list_models', () => {
  it('answer from the settings in force at each call', async () => {
    const answers: unknown[] = [];
    const { session, settings } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        answers.push((await call(mcp!, 'list_runners')).body);
        settings({ enabledRunners: ['claude-code', 'codex'], modelAllowlist: { 'claude-code': ['claude-opus-4'] } });
        answers.push((await call(mcp!, 'list_runners')).body);
        answers.push((await call(mcp!, 'list_models', { runner: 'claude-code' })).body);
        answers.push((await call(mcp!, 'list_models', { runner: 'codex' })).body);
        return 'What should it do?';
      },
    }));

    await session.startPlanning('add a cache', ['claude-code']);

    const runnerIds = (answer: unknown) => (answer as { runners: { id: string }[] }).runners.map((r) => r.id);
    expect(runnerIds(answers[0])).toEqual(['claude-code']);
    expect(runnerIds(answers[1])).toEqual(['claude-code', 'codex']);
    expect(answers[2]).toEqual({
      runner: 'claude-code',
      models: [{ modelId: 'claude-opus-4', modelLabel: 'Claude Opus 4', variants: [{ id: 'high', label: 'High' }] }],
    });
    expect(answers[3]).toEqual({
      runner: 'codex',
      models: [{ modelId: 'gpt-5', modelLabel: 'GPT-5', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] }],
    });
  });
});

function planTask(id: string, order: number, runner: string, modelId: string, extra: Record<string, unknown> = {}) {
  return {
    id, order, title: `Task ${id}`, description: `Does ${id}`, type: 'ai', prompt: `do ${id}`, dependencies: [], subtasks: [],
    sliceType: 'AFK', autonomy: 'AFK', assignedRunner: runner, assignedModel: { modelId, modelLabel: modelId }, ...extra,
  };
}

describe('submit_plan', () => {
  it('refuses a runner switched off since planning started, by name, and commits nothing', async () => {
    let submitted: { isError: boolean; body: unknown } | undefined;
    const { session, settings } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        settings({ enabledRunners: ['claude-code'] });
        submitted = await call(mcp!, 'submit_plan', { tasks: [planTask('a', 1, 'claude-code', 'claude-sonnet-4'), planTask('b', 2, 'codex', 'gpt-5')] });
        return 'Submitted.';
      },
    }), { enabledRunners: ['claude-code', 'codex'] });

    await session.startPlanning('add a cache', ['claude-code', 'codex']);

    expect(submitted?.isError).toBe(true);
    expect(submitted?.body).toEqual({
      ok: false,
      enabledRunners: ['claude-code'],
      errors: [{ taskId: 'b', field: 'assignedRunner', message: 'Task "Task b" has invalid assignedRunner "codex". Expected one of: claude-code' }],
    });
    expect(session.planTasks).toEqual([]);
  });

  it('commits a plan on a runner enabled mid-conversation (#69)', async () => {
    let submitted: { isError: boolean; body: unknown } | undefined;
    const { session, settings } = plannerSession(fakeClaude({
      turn: async (mcp, message) => {
        if (!message.includes('use codex too')) return 'Which runners should I use?';
        await call(mcp!, 'list_runners');
        await call(mcp!, 'list_models', { runner: 'codex' });
        submitted = await call(mcp!, 'submit_plan', { tasks: [planTask('a', 1, 'claude-code', 'claude-sonnet-4'), planTask('b', 2, 'codex', 'gpt-5', { taskMode: 'auto' })] });
        return 'Submitted the plan.';
      },
    }));
    await session.startPlanning('add a cache', ['claude-code']);

    settings({ enabledRunners: ['claude-code', 'codex'] });
    await session.continueConversation('use codex too');

    expect(submitted).toEqual({ isError: false, body: expect.objectContaining({ ok: true, tasks: 2, coerced: [] }) });
    expect(session.planTasks.map((t) => [t.id, t.assignedRunner, t.assignedModel?.modelId])).toEqual([
      ['a', 'claude-code', 'claude-sonnet-4'],
      ['b', 'codex', 'gpt-5'],
    ]);
    expect(session.planState?.runners).toEqual(['claude-code', 'codex']);
  });

  it('names the model the allowlist moved a task off', async () => {
    let submitted: { isError: boolean; body: unknown } | undefined;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        submitted = await call(mcp!, 'submit_plan', {
          tasks: [planTask('a', 1, 'claude-code', 'claude-opus-4', { assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus', thinkingEffort: 'high' } })],
        });
        return 'Submitted.';
      },
    }), { modelAllowlist: { 'claude-code': ['claude-sonnet-4'] } });

    await session.startPlanning('add a cache', ['claude-code']);

    expect((submitted?.body as { coerced: unknown }).coerced).toEqual([
      { taskId: 'a', field: 'assignedModel', from: 'claude-opus-4', to: 'claude-sonnet-4' },
      { taskId: 'a', field: 'thinkingEffort', from: 'high', to: null },
    ]);
    expect(session.planTasks[0].assignedModel?.modelId).toBe('claude-sonnet-4');
  });
});

describe('the two routes to a plan', () => {
  it('commit the same plan for the same tasks: submit_plan, and the JSON envelope in the reply', async () => {
    const tasks = [
      planTask('a', 1, 'claude-code', 'claude-sonnet-4'),
      planTask('b', 2, 'claude-code', 'claude-opus-4', { dependencies: ['a'], taskMode: 'default', assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus', thinkingEffort: 'xhigh' } }),
    ];
    const settings = { modelAllowlist: { 'claude-code': ['claude-sonnet-4', 'claude-opus-4'] } };
    const viaTool = plannerSession(fakeClaude({
      turn: async (mcp) => {
        await call(mcp!, 'submit_plan', { tasks });
        return 'Submitted the plan.';
      },
    }), settings);
    const viaEnvelope = plannerSession(fakeClaude({ turn: async () => JSON.stringify({ tasks }) }), settings, { inject: false });

    await viaTool.session.startPlanning('add a cache', ['claude-code']);
    await viaEnvelope.session.startPlanning('add a cache', ['claude-code']);

    const committed = ({ session, broadcast }: ReturnType<typeof plannerSession>) => ({
      tasks: session.planTasks.map(({ completionMarker: _, ...rest }) => rest),
      runners: session.planState?.runners,
      last: session.planState?.conversationHistory?.at(-1)?.kind,
      planBroadcasts: broadcast.mock.calls.filter(([m]) => m.type === 'plan_generated').length,
    });
    expect(viaTool.session.planTasks).toHaveLength(2);
    expect(committed(viaTool)).toEqual(committed(viaEnvelope));
  });
});

describe('what the planner is told', () => {
  const systemPrompt = (spawned: FakeSpawnResult) => {
    const args = spawned.lastArgs();
    return args[args.indexOf('--append-system-prompt') + 1];
  };

  async function twoTurns(inject: boolean) {
    const messages: string[] = [];
    const claude = fakeClaude({ turn: async (_mcp, message) => { messages.push(message); return 'Which cache?'; } });
    const { session, ai } = plannerSession(claude, {}, { inject });
    await session.startPlanning('add a cache', ['claude-code']);
    await session.continueConversation('in-process');
    return { claude, messages, attached: ai.plannerToolsAttached() };
  }

  it('with the tools: to pull the catalog just before submitting through submit_plan, and no pasted catalog', async () => {
    const { claude, messages, attached } = await twoTurns(true);

    expect(attached).toBe(true);
    const prompt = systemPrompt(claude);
    expect(prompt).toMatch(/list_runners/);
    expect(prompt).toMatch(/list_models/);
    expect(prompt).toMatch(/submit_plan/);
    expect(prompt).not.toContain('claude-sonnet-4');
    expect(prompt).not.toContain('Output ONLY the JSON object');
    expect(messages[1]).not.toContain('<available_models>');
    expect(messages[1]).toMatch(/list_runners/);
  });

  it('without them: today\'s prompt and per-turn catalog, unchanged', async () => {
    const { claude, messages, attached } = await twoTurns(false);

    expect(attached).toBe(false);
    expect(systemPrompt(claude)).toBe(buildConversationSystemPrompt(
      'add a cache', '', { 'claude-code': CATALOG['claude-code'] }, ['claude-code'], runnerModesFrom(new RunnerRegistry(), ['claude-code']), true, false,
      { harness: true, isolatedExecution: undefined },
    ));
    expect(messages[1]).toContain('<available_models>\nclaude-code: claude-sonnet-4, claude-opus-4\n</available_models>');
    expect(messages[1]).not.toMatch(/list_runners|submit_plan/);
  });
});
