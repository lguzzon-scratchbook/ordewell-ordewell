import { describe, it, expect, vi } from 'vitest';
import type { ApiClient } from '../../apiClient';
import { handleRun } from '../run';

type Event = Parameters<Parameters<ApiClient['streamExecution']>[1]>[0];

describe('ordewell run when a task asks a checkpoint', () => {
  it('names the task, its question, and the command that answers it', async () => {
    const script: Event[] = [
      { type: 'checkpoint', taskId: 't1', taskTitle: 'Migrate the schema', summary: 'Drop the users table?\nIt holds 40k rows.' },
      { type: 'execution_complete', summary: { total: 1, completed: 1, failed: 0 } },
    ];
    const api = {
      streamExecution: vi.fn((_id: string, onEvent: (e: Event) => void, onReady?: (error?: Error) => void) => new Promise<void>((resolve) => {
        setTimeout(() => onReady?.(), 0);
        setTimeout(() => { script.forEach(onEvent); resolve(); }, 5);
      })),
      executePlan: vi.fn().mockResolvedValue({ status: 'running' }),
    } as unknown as ApiClient;
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await handleRun(['--session-id', 's1'], api);
    } finally {
      stderr.mockRestore();
      log.mockRestore();
    }

    expect(written.join('')).toContain('· Checkpoint — Migrate the schema: Drop the users table? — `ordewell checkpoint <id> approve|reject [reason]` answers it');
  });
});
