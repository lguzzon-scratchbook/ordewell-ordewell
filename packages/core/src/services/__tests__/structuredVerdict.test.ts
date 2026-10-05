import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OrdewellMcpServer } from '../mcp';
import { VerdictEngine } from '../VerdictEngine';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { createTask } from '../../models/Task';
import type { Verdict } from '../../models/Task';
import { isStructuredSession, type ITerminalSession } from '../../interfaces/ITerminalRunner';
import { fakeSpawn, fixture, type ScriptedReply } from './harnessTestKit';

/**
 * `VerdictEngine` is unchanged by the structured transport (ADR-0018, O1a): it
 * reads the same plain text, and answers a checkpoint through the same
 * `session.write` — which a structured session turns into a user turn. Driven
 * here through the real Claude Code adapter and recorded transcripts.
 */

function running(replies: ScriptedReply[], marker: string) {
  const spawned = fakeSpawn(replies);
  const runner = new StructuredRunner({
    process: { spawn: spawned.spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
  });
  const engine = new VerdictEngine();
  const verdicts: Verdict[] = [];
  const checkpoints: string[] = [];
  engine.onVerdict((_taskId, verdict) => verdicts.push(verdict));
  engine.onCheckpoint((_taskId, summary) => checkpoints.push(summary));
  const task = createTask({ id: 't1', title: 'Only', taskMode: 'acceptEdits', completionMarker: marker });
  const start = async (): Promise<ITerminalSession> => {
    const session = await runner.spawn({ taskId: 't1', runner: 'claude-code', prompt: 'Do the task', mode: 'acceptEdits', cwd: '/repo', registry: new RunnerRegistry() });
    engine.watch(task, session);
    return session;
  };
  return { spawned, engine, verdicts, checkpoints, start };
}

/** The text of each user turn the adapter wrote to the runner's stdin. */
function userTurns(written: string[]): string[] {
  return written
    .map((line) => JSON.parse(line) as { type: string; message?: { content: Array<{ text: string }> } })
    .filter((msg) => msg.type === 'user')
    .map((msg) => msg.message?.content[0].text ?? '');
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await tick();
  if (!condition()) throw new Error('condition never held');
}

describe('VerdictEngine over a structured session', () => {
  it('passes on the marker in the runner\'s text, and leaves the session to its owner', async () => {
    const run = running([fixture('claude-code', 'task-marker')], 'test-1234');
    const session = await run.start();
    await until(() => run.verdicts.length === 1);

    expect(run.verdicts[0].outcome).toBe('pass');
    expect(run.spawned.processes[0].killed).toBe(false);
    session.kill();
    await tick();
    expect(run.verdicts).toHaveLength(1);
  });

  it('never passes a runner that stopped without the marker, whatever its exit code', async () => {
    const run = running([fixture('claude-code', 'task-no-marker')], 'test-1234');
    const session = await run.start();
    if (!isStructuredSession(session)) throw new Error('expected a structured session');
    await new Promise<void>((resolve) => session.onTurnEnd(() => resolve()));
    expect(run.verdicts).toEqual([]);

    run.spawned.processes[0].exit(0);
    await until(() => run.verdicts.length === 1);
    expect(run.verdicts[0].outcome).toBe('fail');
  });

  it('answers an approved checkpoint as a user turn, and the continued turn\'s marker passes the task', async () => {
    const run = running([fixture('claude-code', 'task-checkpoint'), fixture('claude-code', 'task-marker')], 'test-1234');
    await run.start();
    await until(() => run.checkpoints.length === 1);
    expect(run.checkpoints).toEqual(['about to delete README.md']);
    expect(run.verdicts).toEqual([]);

    run.engine.approveCheckpoint('t1');

    await until(() => run.verdicts.length === 1);
    expect(userTurns(run.spawned.processes[0].written)).toEqual(['Do the task', 'ORDEWELL_CONTINUE']);
    expect(run.verdicts[0].outcome).toBe('pass');
    expect(run.checkpoints).toHaveLength(1);
  });

  it('answers a rejected checkpoint as a user turn carrying the reason', async () => {
    const run = running([fixture('claude-code', 'task-checkpoint'), fixture('claude-code', 'task-no-marker')], 'test-1234');
    const session = await run.start();
    await until(() => run.checkpoints.length === 1);

    run.engine.rejectCheckpoint('t1', 'keep the README');

    await until(() => userTurns(run.spawned.processes[0].written).length === 2);
    expect(userTurns(run.spawned.processes[0].written)).toEqual(['Do the task', 'ORDEWELL_REJECT: keep the README']);
    // Answered once: a second answer has no paused session to reach.
    run.engine.approveCheckpoint('t1');
    await tick();
    expect(userTurns(run.spawned.processes[0].written)).toHaveLength(2);
    session.kill();
  });
});

describe('VerdictEngine over a Claude Code task given the Ordewell server (ADR-0022)', () => {
  const servers: OrdewellMcpServer[] = [];
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await Promise.all(servers.splice(0).map((s) => s.dispose()));
  });

  /** What the CLI reads from its `--mcp-config` file. */
  function runnerConfig(args: string[]): { url: string; headers: Record<string, string> } {
    const file = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')) as {
      mcpServers: { ordewell: { url: string; headers: Record<string, string> } };
    };
    return file.mcpServers.ordewell;
  }

  async function connect({ url, headers }: { url: string; headers: Record<string, string> }): Promise<Client> {
    const client = new Client({ name: 'claude-code', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    clients.push(client);
    return client;
  }

  it('passes on a task_complete call made mid-turn, before any marker', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const spawned = fakeSpawn([]);
    const runner = new StructuredRunner({
      process: { spawn: spawned.spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
      mcp: server,
    });
    const engine = new VerdictEngine();
    const verdicts: Verdict[] = [];
    engine.onVerdict((_taskId, verdict) => verdicts.push(verdict));
    const task = createTask({ id: 't1', title: 'Only', taskMode: 'acceptEdits', completionMarker: 'test-1234' });
    const session = await runner.spawn({ taskId: 't1', runner: 'claude-code', prompt: 'Do the task', mode: 'acceptEdits', cwd: '/repo', registry: new RunnerRegistry(), attempt: 1 });
    engine.watch(task, session);

    const config = runnerConfig(spawned.lastArgs());
    const client = await connect(config);
    await client.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 'Did it.' } });

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].outcome).toBe('pass');
    session.kill();
    await expect(connect(config)).rejects.toThrow();
  });
});
