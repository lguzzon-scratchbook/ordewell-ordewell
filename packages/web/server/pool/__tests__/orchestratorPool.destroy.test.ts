import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Session, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';

describe('closing a session', () => {
  it('closes the session it is still planning in, which abandons its planner turn', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-destroy-'));
    mkdirSync(join(workspace, '.git'));
    const pool = new OrchestratorPool();
    const startSpy = vi.spyOn(Session.prototype, 'startPlanning').mockReturnValue(new Promise<LegacyPlanState>(() => {}));
    const destroySpy = vi.spyOn(Session.prototype, 'destroy');

    try {
      void pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
      const session = pool.session('s1');

      pool.destroy('s1');

      expect(destroySpy.mock.contexts).toContain(session);
      expect(pool.hasSession('s1')).toBe(false);
      expect(pool.cancelPlanning('s1')).toBe(false);
    } finally {
      startSpy.mockRestore();
      destroySpy.mockRestore();
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('re-planning under a live session id', () => {
  it('destroys the previous session rather than orphaning its turn', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-replan-'));
    mkdirSync(join(workspace, '.git'));
    const pool = new OrchestratorPool();
    const destroySpy = vi.spyOn(Session.prototype, 'destroy');
    const spy = vi.spyOn(Session.prototype, 'startPlanning').mockReturnValue(new Promise<LegacyPlanState>(() => {}));

    try {
      void pool.startPlanning('s1', 'first', ['claude-code'], workspace);
      const first = pool.session('s1');

      void pool.startPlanning('s1', 'second', ['claude-code'], workspace);

      expect(destroySpy.mock.contexts).toContain(first);
      expect(pool.session('s1')).not.toBe(first);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      destroySpy.mockRestore();
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('subscribing to a session', () => {
  it('sends a new socket nothing of the transcript: every client reads the conversation over REST, and a turn opens a socket each time', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-subscribe-'));
    mkdirSync(join(workspace, '.git'));
    const pool = new OrchestratorPool();
    const history = [{ role: 'user' as const, content: 'ship it', timestamp: '2026-01-01T00:00:00Z' }];
    const planSpy = vi.spyOn(Session.prototype, 'planState', 'get').mockReturnValue({ conversationHistory: history } as unknown as LegacyPlanState);
    const startSpy = vi.spyOn(Session.prototype, 'startPlanning').mockResolvedValue({} as LegacyPlanState);

    try {
      await pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
      const ws = { OPEN: 1, readyState: 1, send: vi.fn() };
      pool.subscribe('s1', ws as unknown as Parameters<OrchestratorPool['subscribe']>[1]);

      expect(ws.send).not.toHaveBeenCalled();
    } finally {
      planSpy.mockRestore();
      startSpy.mockRestore();
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
