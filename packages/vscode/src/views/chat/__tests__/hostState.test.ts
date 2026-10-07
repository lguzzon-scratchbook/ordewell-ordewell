import { describe, it, expect } from 'vitest';
import type { LegacyPlanState } from '@ordewell/core';
import { reduceHost, resetSession, INITIAL_HOST_STATE, type HostState, type HostMessage } from '../hostState';

const NOW = 1_000;
const msg = (m: { type: HostMessage['type'] } & Record<string, unknown>): HostMessage => ({ now: NOW, ...m }) as HostMessage;

function planWith(status: string): LegacyPlanState {
  return { status, tasks: [] } as unknown as LegacyPlanState;
}

function staleSession(): HostState {
  return {
    ...INITIAL_HOST_STATE,
    plan: planWith('running'),
    isExecuting: true,
    isResearchActive: true,
    error: 'boom',
    taskIdle: { t1: '2026-01-01T00:00:00Z' },
    taskApprovals: { t1: 2 },
    taskOutput: { t1: [] } as unknown as HostState['taskOutput'],
    taskGates: { t1: ['t0'] },
    dockExpanded: true,
  };
}

describe('resetSession', () => {
  it('clears stale stalled and approval badges on restore', () => {
    const next = reduceHost(staleSession(), msg({ type: 'restoreChat' }));
    expect(next.taskIdle).toEqual({});
    expect(next.taskApprovals).toEqual({});
    expect(next.plan).toBeNull();
    expect(next.isResearchActive).toBe(false);
    expect(next.isExecuting).toBe(false);
  });

  it("'empty' clears badges but leaves running flags and held prompts alone", () => {
    const held = { ...INITIAL_HOST_STATE.held };
    const next = resetSession({ ...staleSession(), held, stopped: true }, 'empty');
    expect(next.taskIdle).toEqual({});
    expect(next.taskApprovals).toEqual({});
    expect(next.error).toBe('');
    expect(next.isResearchActive).toBe(true);
    expect(next.held).toBe(held);
    expect(next.stopped).toBe(true);
  });

  it("'restore' opens the gates and 'new' closes them", () => {
    const gated = { ...staleSession(), stopped: true, sessionCleared: true };
    const restored = resetSession(gated, 'restore');
    expect(restored.stopped).toBe(false);
    expect(restored.sessionCleared).toBe(false);
    const fresh = resetSession(staleSession(), 'new');
    expect(fresh.stopped).toBe(true);
    expect(fresh.sessionCleared).toBe(true);
  });

  it('is not undone by a conversation reset: the conversation stays the host\'s', () => {
    const before = staleSession();
    expect(resetSession(before, 'new').conversation).toBe(before.conversation);
  });
});

describe('reduceHost gates', () => {
  it('drops planUpdated while stopped until a planner turn opens', () => {
    const stopped = reduceHost(staleSession(), { type: 'turnStopped' });
    const dropped = reduceHost(stopped, msg({ type: 'planUpdated', plan: planWith('draft') }));
    expect(dropped).toBe(stopped);
    const reopened = reduceHost(stopped, msg({ type: 'plannerTurn', active: true }));
    expect(reduceHost(reopened, msg({ type: 'planUpdated', plan: planWith('draft') })).plan?.status).toBe('draft');
  });

  it('drops showError after a new session until the next send', () => {
    const cleared = reduceHost(staleSession(), { type: 'resetSession', kind: 'new' });
    expect(reduceHost(cleared, msg({ type: 'showError', error: 'late' })).error).toBe('');
    const sent = reduceHost(cleared, { type: 'turnRequested' });
    expect(reduceHost(sent, msg({ type: 'showError', error: 'real' })).error).toBe('real');
  });

  it('stamps the checkpoint with the action clock', () => {
    const next = reduceHost(INITIAL_HOST_STATE, msg({ type: 'checkpoint', taskId: 't1', taskTitle: 'T', summary: 's' }));
    expect(next.checkpoint?.pausedAt).toBe(NOW);
  });

  it('only changes the approvals reference when the count changes', () => {
    const once = reduceHost(INITIAL_HOST_STATE, msg({ type: 'taskApprovals', taskId: 't1', count: 1 }));
    expect(reduceHost(once, msg({ type: 'taskApprovals', taskId: 't1', count: 1 }))).toBe(once);
  });
});
