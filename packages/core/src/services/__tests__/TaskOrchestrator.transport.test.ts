import { describe, it, expect, vi } from 'vitest';
import { createTaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { serializeTaskStatus } from '../SessionMessage';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeStructuredSession, FakeTerminalSession, flushMicrotasks } from '../../testing';
import { fakeNotification, makeSession, saves } from './sessionTestKit';
import type { ITerminalRunner, ITerminalSession, RunnerTransport } from '../../interfaces/ITerminalRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';

/**
 * The runner a {@link TransportRouter} would be: a structured session for a
 * structured request on Claude Code, a terminal one otherwise. Records what
 * each spawn asked for.
 */
function routingRunner() {
  const sessions: FakeTerminalSession[] = [];
  const requests: RunnerSpawnOptions[] = [];
  const runner = {
    spawn: vi.fn(async (opts: RunnerSpawnOptions): Promise<ITerminalSession> => {
      requests.push(opts);
      const id = `s${sessions.length + 1}`;
      const session = opts.transport === 'structured' && opts.runner === 'claude-code'
        ? new FakeStructuredSession(id, opts.taskId, `native-${opts.taskId}`)
        : new FakeTerminalSession(id, opts.taskId);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies ITerminalRunner;
  return { runner, sessions, requests };
}

function orchestratorWith(setting: { value: RunnerTransport }, runner: ITerminalRunner) {
  return createTaskOrchestrator({
    config: fakeConfig(),
    notifications: fakeNotification(),
    terminalRunner: runner,
    output: new BufferedTaskOutputSource({ transcripts: { finalAssistantText: async () => null } }),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    runnerTransport: () => setting.value,
  });
}

const settle = () => flushMicrotasks(50);

describe('the runnerTransport setting, copied when a run opens', () => {
  it('holds for every task of the run, and a change mid-run waits for the next run', async () => {
    const setting = { value: 'structured' as RunnerTransport };
    const { runner, sessions, requests } = routingRunner();
    const orchestrator = orchestratorWith(setting, runner);
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'one', completionMarker: 'mk-1' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'two', completionMarker: 'mk-2', dependencies: ['t1'] }),
    ]);

    await orchestrator.approveReview();
    expect(orchestrator.runnerTransport).toBe('structured');
    expect(requests[0].transport).toBe('structured');

    setting.value = 'terminal';
    sessions[0].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].transport).toBe('structured');
    expect(orchestrator.runnerTransport).toBe('structured');

    sessions[1].emitOutput('<<<ORDEWELL_DONE_mk-2>>>');
    await vi.waitFor(() => expect(orchestrator.status).toBe('completed'));

    // The next run — here a manual run of one task — reads the setting afresh.
    await orchestrator.retryTask('t2');
    await orchestrator.runTask('t2');
    await settle();
    expect(requests.at(-1)?.transport).toBe('terminal');
    expect(orchestrator.runnerTransport).toBe('terminal');
  });

  it('is copied by a force start that opens a run', async () => {
    const setting = { value: 'structured' as RunnerTransport };
    const { runner, requests } = routingRunner();
    const orchestrator = orchestratorWith(setting, runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);

    await orchestrator.forceStartTask('t1');

    expect(requests[0].transport).toBe('structured');
    expect(orchestrator.runnerTransport).toBe('structured');
  });

  it('is persisted on the plan, and a setting changed mid-run does not rewrite it', async () => {
    const settings = { tddEnabled: false, runnerTransport: 'structured' as RunnerTransport };
    const { runner, sessions } = routingRunner();
    const session = makeSession({ runner, settings: () => settings });
    const plan: LegacyPlanState = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', completionMarker: 'mk-1' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
    session.loadPlan(plan, 'Goal', '/repo');
    expect(saves(session).mock.lastCall?.[0].runnerTransport).toBeUndefined();

    await session.executePlan();
    settings.runnerTransport = 'terminal';
    sessions[0].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');

    await vi.waitFor(() => expect(saves(session).mock.lastCall?.[0].tasks[0].status).toBe('completed'));
    expect(saves(session).mock.lastCall?.[0].runnerTransport).toBe('structured');
  });
});

describe('recording the transport on the task', () => {
  it('records a structured task, and says so on its status', async () => {
    const { runner } = routingRunner();
    const orchestrator = orchestratorWith({ value: 'structured' }, runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);

    await orchestrator.forceStartTask('t1');

    const task = orchestrator.storeInstance.get('t1')!;
    expect(task.transport).toEqual({ kind: 'structured' });
    expect(serializeTaskStatus(task).transport).toEqual({ kind: 'structured' });
  });

  it('records the fallback and its reason for a runner with no connector', async () => {
    const { runner } = routingRunner();
    const orchestrator = orchestratorWith({ value: 'structured' }, runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'my-plugin' })], ['my-plugin']);

    await orchestrator.forceStartTask('t1');

    const status = serializeTaskStatus(orchestrator.storeInstance.get('t1')!);
    expect(status.transport).toEqual({ kind: 'terminal', fallback: 'no structured connector for my-plugin yet' });
  });

  it('names a host that cannot run structured tasks as the reason, never falling back silently', async () => {
    const runner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions) => new FakeTerminalSession('s1', opts.taskId)),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies ITerminalRunner;
    const orchestrator = orchestratorWith({ value: 'structured' }, runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);

    await orchestrator.forceStartTask('t1');

    expect(orchestrator.storeInstance.get('t1')!.transport).toEqual({ kind: 'terminal', fallback: 'this surface cannot run structured tasks' });
  });

  it('records nothing on a terminal plan', async () => {
    const { runner } = routingRunner();
    const orchestrator = orchestratorWith({ value: 'terminal' }, runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);

    await orchestrator.forceStartTask('t1');

    const task = orchestrator.storeInstance.get('t1')!;
    expect(task.transport).toBeUndefined();
    expect(serializeTaskStatus(task)).not.toHaveProperty('transport');
  });
});

describe('ending a structured attempt', () => {
  it('stops the structured session once its task passes, instead of leaving it running', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith({ value: 'structured' }, runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', completionMarker: 'mk-1' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput('Done.\n<<<ORDEWELL_DONE_mk-1>>>\n');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

    expect(runner.stop).toHaveBeenCalledWith('s1');
    expect(orchestrator.storeInstance.get('t1')!.verdict?.outcome).toBe('pass');
  });

  it('saves the runner\'s own session id on the task for a later continue', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith({ value: 'structured' }, runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', completionMarker: 'mk-1' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

    expect(orchestrator.storeInstance.get('t1')!.transport).toEqual({ kind: 'structured', nativeSessionId: 'native-t1' });
  });

  it('leaves a terminal task\'s runner up after its pass, as before', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith({ value: 'terminal' }, runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', completionMarker: 'mk-1' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

    expect(runner.stop).not.toHaveBeenCalled();
  });
});

describe('completing through task_complete (ADR-0022)', () => {
  it('teaches the tool only to a structured task whose runner is given it', async () => {
    const { runner, requests } = routingRunner();
    const orchestrator = orchestratorWith({ value: 'structured' }, runner);
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Claude', prompt: 'one' }),
      createTask({ id: 't2', order: 2, title: 'Codex', prompt: 'two', assignedRunner: 'codex' }),
    ], ['claude-code', 'codex']);
    await orchestrator.forceStartTask('t1');
    await orchestrator.forceStartTask('t2');

    expect(requests[0].prompt).toContain('`task_complete`');
    expect(requests[1].prompt).not.toContain('task_complete');

    const terminal = routingRunner();
    const onTerminal = orchestratorWith({ value: 'terminal' }, terminal.runner);
    onTerminal.loadPlan([createTask({ id: 't1', order: 1, title: 'Claude', prompt: 'one' })]);
    await onTerminal.forceStartTask('t1');
    expect(terminal.requests[0].prompt).not.toContain('task_complete');
  });

  it('numbers each attempt it spawns', async () => {
    const { runner, sessions, requests } = routingRunner();
    const orchestrator = orchestratorWith({ value: 'structured' }, runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');
    sessions[0].emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

    await orchestrator.retryTask('t1');
    await orchestrator.runTask('t1');
    await settle();

    expect(requests.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it('passes a task on a done call, and hands its summary to dependents', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith({ value: 'structured' }, runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', completionMarker: 'mk-1' })]);
    await orchestrator.forceStartTask('t1');
    const session = sessions[0] as FakeStructuredSession;
    session.emitOutput('a screen of work\n');

    session.reportComplete({ status: 'done', summary: 'Added the parser and its tests.' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

    const task = orchestrator.storeInstance.get('t1')!;
    expect(task.verdict?.checks[0].name).toBe('task_complete');
    expect(task.outputSummary?.logTail).toBe('Added the parser and its tests.');
    expect(runner.stop).toHaveBeenCalledWith('s1');
  });

  it('fails a task on a blocked call, saying why', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith({ value: 'structured' }, runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', completionMarker: 'mk-1' })]);
    await orchestrator.forceStartTask('t1');

    (sessions[0] as FakeStructuredSession).reportComplete({ status: 'blocked', summary: 'Nothing changed.', reason: 'the schema file is missing' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

    expect(orchestrator.storeInstance.get('t1')!.verdict?.reason).toContain('the schema file is missing');
  });
});
