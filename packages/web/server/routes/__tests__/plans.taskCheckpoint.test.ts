import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { OrchestratorPool } from '../../pool/orchestratorPool';
import { plansRoute } from '../plans';

function appFor(session: Record<string, unknown>, known = true) {
  const pool = {
    session: vi.fn(() => {
      if (!known) throw new Error('Session not found');
      return session;
    }),
  } as unknown as OrchestratorPool;
  const app = new Hono();
  app.route('/api/plans', plansRoute(pool));
  return app;
}

const post = (app: Hono, path: string, body?: unknown) => app.request(`/api/plans/s1/tasks/t1/checkpoint/${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

describe('answering a task checkpoint over the daemon', () => {
  it('approves the waiting checkpoint', async () => {
    const approveCheckpoint = vi.fn();
    const res = await post(appFor({ awaitsCheckpoint: () => true, approveCheckpoint }), 'approve');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(approveCheckpoint).toHaveBeenCalledWith('t1');
  });

  it('rejects it with the reason, trimmed', async () => {
    const rejectCheckpoint = vi.fn();
    const res = await post(appFor({ awaitsCheckpoint: () => true, rejectCheckpoint }), 'reject', { reason: '  keep the table  ' });

    expect(res.status).toBe(200);
    expect(rejectCheckpoint).toHaveBeenCalledWith('t1', 'keep the table');
  });

  it.each([
    ['no body', undefined],
    ['an empty reason', { reason: '   ' }],
    ['a reason that is not text', { reason: 4 }],
  ])('rejects with no reason for %s', async (_name, body) => {
    const rejectCheckpoint = vi.fn();
    const res = await post(appFor({ awaitsCheckpoint: () => true, rejectCheckpoint }), 'reject', body);

    expect(res.status).toBe(200);
    expect(rejectCheckpoint).toHaveBeenCalledWith('t1', undefined);
  });

  it('answers 409 and says why when nothing is waiting, for either answer', async () => {
    const approveCheckpoint = vi.fn();
    const rejectCheckpoint = vi.fn();
    const app = appFor({ awaitsCheckpoint: () => false, approveCheckpoint, rejectCheckpoint });

    for (const res of [await post(app, 'approve'), await post(app, 'reject', { reason: 'no' })]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: expect.stringContaining('not waiting at a checkpoint') });
    }
    expect(approveCheckpoint).not.toHaveBeenCalled();
    expect(rejectCheckpoint).not.toHaveBeenCalled();
  });

  it('answers 404 for a session the daemon does not have', async () => {
    expect((await post(appFor({}, false), 'approve')).status).toBe(404);
    expect((await post(appFor({}, false), 'reject')).status).toBe(404);
  });
});
