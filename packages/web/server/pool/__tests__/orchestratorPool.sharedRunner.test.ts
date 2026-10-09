import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunnerRegistry, saveSession, TransportRouter, type ITerminalRunner, type ITerminalSession, type LegacyPlanState } from '@ordewell/core';

const poolAwareRunnerCtor = vi.fn();
vi.mock('../../adapters/PoolAwareRunner', () => ({
  PoolAwareRunner: vi.fn().mockImplementation(function (...args: unknown[]) {
    poolAwareRunnerCtor(...args);
    return { activeCount: 0, spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn() };
  }),
}));

import { OrchestratorPool } from '../orchestratorPool';

function savedPlan(): LegacyPlanState {
  return {
    status: 'approved',
    runners: ['opencode'],
    generatedAt: '2026-07-21T10:00:00.000Z',
    tasks: [
      { id: 't1', order: 1, title: 'Add the limiter', type: 'ai', status: 'pending', description: 'd', dependencies: [], assignedRunner: 'opencode', subtasks: [] },
    ],
  } as unknown as LegacyPlanState;
}

describe('OrchestratorPool shared runner injection', () => {
  let workspace: string;

  beforeEach(() => {
    poolAwareRunnerCtor.mockClear();
    workspace = mkdtempSync(join(tmpdir(), 'ordewell-pool-runner-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  /** The runner the pool handed the one session it created; a router over the terminal and structured runners. */
  function routerOf(): ITerminalRunner {
    const [, , inner] = poolAwareRunnerCtor.mock.calls.at(-1) as [string, unknown, ITerminalRunner];
    expect(inner).toBeInstanceOf(TransportRouter);
    return inner;
  }

  function fakeRunner(): ITerminalRunner {
    return { activeCount: 0, spawn: vi.fn(async () => ({}) as ITerminalSession), stop: vi.fn(), stopAll: vi.fn() };
  }

  const spawnOpts = { taskId: 't1', prompt: 'p', cwd: '/repo', registry: new RunnerRegistry() };

  it('routes every session\'s terminal tasks to an injected shared runner', async () => {
    const runner = fakeRunner();
    const structuredRunner = fakeRunner();
    const pool = new OrchestratorPool({ runner, structuredRunner });

    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-shared');
    pool.adoptSavedSession(meta.id, workspace);
    await routerOf().spawn({ ...spawnOpts, runner: 'my-plugin', transport: 'structured' });

    expect(runner.spawn).toHaveBeenCalledOnce();
    expect(structuredRunner.spawn).not.toHaveBeenCalled();
  });

  it('routes a structured Claude Code task to the shared structured runner', async () => {
    const runner = fakeRunner();
    const structuredRunner = fakeRunner();
    const pool = new OrchestratorPool({ runner, structuredRunner });

    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-structured');
    pool.adoptSavedSession(meta.id, workspace);
    await routerOf().spawn({ ...spawnOpts, runner: 'claude-code', transport: 'structured' });

    expect(structuredRunner.spawn).toHaveBeenCalledOnce();
    expect(runner.spawn).not.toHaveBeenCalled();
  });

  it('gives each session a router of its own when no runner is injected, preserving the per-session HeadlessRunner', () => {
    const pool = new OrchestratorPool();

    pool.adoptSavedSession(saveSession(savedPlan(), 'One', workspace, 'session-a').id, workspace);
    const first = routerOf();
    pool.adoptSavedSession(saveSession(savedPlan(), 'Two', workspace, 'session-b').id, workspace);

    expect(routerOf()).not.toBe(first);
  });
});
