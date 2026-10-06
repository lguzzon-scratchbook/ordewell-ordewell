import type { AwaitingReason } from '../models/Task';

/**
 * What a row's status means to a reader, before any surface picks a word,
 * icon or colour for it. `quiet` is a running task whose runner has printed
 * nothing for a while — the status is still `in_progress`, so only the row,
 * never the store, tells the two apart.
 */
export type TaskStatusKind = 'todo' | 'running' | 'quiet' | 'awaiting' | 'blocked' | 'failed' | 'done';

/** A task with a runner live behind it. `in_progress` is the store's own status. */
export const isTaskRunning = (task: { status: string }): boolean =>
  task.status === 'in_progress' || task.status === 'running';

/** Statuses of a task that has not started: what can still be started by hand, or flipped between change and ops (ADR-0020). */
export const NOT_STARTED: ReadonlySet<string> = new Set(['pending', 'approved', 'blocked']);

export function taskStatusKind(task: { status: string; idleSince?: string | null }): TaskStatusKind {
  switch (task.status) {
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'blocked': return 'blocked';
    case 'awaiting_user': return 'awaiting';
  }
  if (!isTaskRunning(task)) return 'todo';
  return task.status === 'in_progress' && task.idleSince ? 'quiet' : 'running';
}

const AWAITING_LABELS: Record<AwaitingReason, string> = {
  input: 'Waiting for your input',
  checkpoint: 'Checkpoint',
  conflict: 'Merge conflict',
  'files-changed': 'Changed tracked files',
};

/** What an awaiting_user task waits on (ADR-0018, W1); null when no reason was saved. */
export function awaitingLabel(task: { status: string; awaitingReason?: AwaitingReason }): string | null {
  return task.status === 'awaiting_user' && task.awaitingReason ? AWAITING_LABELS[task.awaitingReason] : null;
}

/** Runner requests a task waits on (ADR-0018, A1); null when none do. */
export function approvalLabel(count: number | undefined): string | null {
  if (!count) return null;
  return count > 1 ? `Waiting for approval (${count})` : 'Waiting for approval';
}
