import { describe, it, expect, vi } from 'vitest';
import { makeSession, FakeTerminalSession } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { createTask, flattenTasks, type LegacyPlanState, type Task } from '../../models/Task';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import type { Session } from '../createSession';
import type { SessionMessage } from '../SessionMessage';

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, completionMarker: `mk-${id}`, ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

const statuses = (tasks: ReadonlyArray<{ id: string; status: string }>) =>
  tasks.map((t) => `${t.id}:${t.status}`).sort().join(' ');

/**
 * A Session whose every save and status announcement is recorded in order,
 * each with the task statuses it carried.
 */
function setup(tasks: Task[], isolation = new FakeWorktreeIsolation()) {
  const terminals: FakeTerminalSession[] = [];
  const runner = {
    spawn: vi.fn(async (opts: { taskId: string }) => {
      const t = new FakeTerminalSession(`s${terminals.length + 1}`, opts.taskId);
      terminals.push(t);
      return t;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } as unknown as ITerminalRunner;
  const seen: { kind: 'save' | 'status'; statuses: string }[] = [];
  const messages: SessionMessage[] = [];
  const session = makeSession({
    runner,
    isolation,
    saveSession: (p) => { seen.push({ kind: 'save', statuses: statuses(flattenTasks(p.tasks)) }); },
    broadcast: (m) => {
      messages.push(m);
      if (m.type === 'status_update') seen.push({ kind: 'status', statuses: statuses(m.tasks) });
    },
  });
  session.loadPlan(plan(tasks), 'goal', '/repo', { persist: false });
  const terminal = (taskId: string) => terminals.find((t) => t.taskId === taskId)!;
  return { session, seen, messages, terminal };
}

/**
 * Run one user control and check that no surface was told a task status the
 * disk did not have yet, and that the disk ends up with what the control left.
 */
async function expectSavedBeforeAnnounced(env: ReturnType<typeof setup>, control: (session: Session) => unknown): Promise<void> {
  env.seen.length = 0;
  await control(env.session);

  let disk: string | undefined;
  for (const { kind, statuses: s } of env.seen) {
    if (kind === 'save') disk = s;
    else expect(s).toBe(disk);
  }
  expect(disk).toBe(statuses(flattenTasks(env.session.planTasks)));
}

describe('every user control saves before it announces', () => {
  it('retry', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();
    env.terminal('t1').emitExit(1);
    await vi.waitFor(() => expect(env.session.planTasks[0].status).toBe('failed'));

    await expectSavedBeforeAnnounced(env, (s) => s.retryTask('t1'));
    expect(env.session.planTasks[0].status).toBe('in_progress');
  });

  it('cancel', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s.cancelTask('t1'));
    expect(env.session.planTasks[0].status).toBe('pending');
  });

  it('mark complete, which starts the dependent', async () => {
    const env = setup([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s.markTaskComplete('t1'));
    expect(env.session.planTasks.map((t) => t.status)).toEqual(['completed', 'in_progress']);
  });

  it('mark not done', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();
    await env.session.markTaskComplete('t1');

    await expectSavedBeforeAnnounced(env, (s) => s.markTaskIncomplete('t1'));
    expect(env.session.planTasks[0].status).not.toBe('completed');
  });

  it('force start', async () => {
    const env = setup([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s.forceStartTask('t2'));
    expect(env.session.planTasks[1].status).toBe('in_progress');
  });

  it('run one task', async () => {
    const env = setup([task('t1', 1)]);

    await expectSavedBeforeAnnounced(env, (s) => s.runTask('t1'));
    expect(env.session.planTasks[0].status).toBe('in_progress');
  });

  it('execute', async () => {
    const env = setup([task('t1', 1)]);

    await expectSavedBeforeAnnounced(env, (s) => s.executePlan());
    expect(env.session.planTasks[0].status).toBe('in_progress');
  });

  it('stop', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s.stopExecution());
    expect(env.session.planTasks[0].status).toBe('pending');
  });

  it.each(['continueWithStash', 'continueWithoutIsolation'] as const)('%s on a dirty tree', async (control) => {
    const isolation = new FakeWorktreeIsolation();
    isolation.availability = { active: false, reason: 'dirty' };
    const env = setup([task('t1', 1)], isolation);
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s[control]());
    expect(env.session.planTasks[0].status).toBe('in_progress');
  });

  it.each(['cleanupRun', 'discardRun'] as const)('%s of a settled run', async (control) => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();
    env.terminal('t1').emitOutput('<<<ORDEWELL_DONE_mk-t1>>>');
    await vi.waitFor(() => expect(env.messages.map((m) => m.type)).toContain('execution_complete'));

    await expectSavedBeforeAnnounced(env, (s) => s[control]());
  });
});
