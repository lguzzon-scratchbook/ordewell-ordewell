import { NOT_STARTED } from './status';

/** What a user can do to one task from its row. */
export type TaskRowAction = 'cancel' | 'skip' | 'force-start' | 'complete' | 'uncomplete';

/** A subtask runs with its parent, so its row offers a different set than a top-level task's. */
export type TaskRowPlacement = 'task' | 'subtask';

interface ActionSubject {
  status: string;
  type: 'ai' | 'user';
}

type Rule = readonly [TaskRowAction, (task: ActionSubject) => boolean];

const UNSTARTED_AI = (t: ActionSubject): boolean => t.type === 'ai' && NOT_STARTED.has(t.status);
const QUEUED = (t: ActionSubject): boolean => t.status === 'pending' || t.status === 'approved';

// Order is the order a surface lays the actions out in.
const TASK_RULES: readonly Rule[] = [
  ['cancel', (t) => t.status === 'in_progress'],
  ['skip', (t) => t.status === 'blocked'],
  ['force-start', UNSTARTED_AI],
  // A manual task has no runner to report it done, so it can always be marked.
  ['complete', (t) => t.status === 'awaiting_user' || t.type === 'user'],
  ['uncomplete', (t) => t.status === 'completed'],
];

const SUBTASK_RULES: readonly Rule[] = [
  ['cancel', (t) => t.status === 'in_progress'],
  ['complete', (t) => t.status === 'in_progress' && t.type === 'ai'],
  ['force-start', (t) => t.type === 'ai' && QUEUED(t)],
  ['skip', QUEUED],
  ['complete', (t) => t.status === 'awaiting_user'],
  ['uncomplete', (t) => t.status === 'completed'],
];

/** The actions a task's row offers while a plan runs, in the order they are laid out. */
export function taskRowActions(task: ActionSubject, placement: TaskRowPlacement = 'task'): TaskRowAction[] {
  const rules = placement === 'subtask' ? SUBTASK_RULES : TASK_RULES;
  return rules.filter(([, applies]) => applies(task)).map(([action]) => action);
}

/**
 * One toggle in both directions: a done task is taken back, anything else is
 * marked done. A second control for the reverse is one nobody remembers.
 */
export function markAction(task: { status: string }): 'complete' | 'uncomplete' {
  return task.status === 'completed' ? 'uncomplete' : 'complete';
}

/**
 * The mark an action asks the session for, or null when it is not a mark.
 * Skip has no request of its own: a skipped task is marked complete, so the
 * run moves on past it.
 */
export function markRequestFor(action: string): 'complete' | 'uncomplete' | null {
  if (action === 'complete' || action === 'skip') return 'complete';
  if (action === 'uncomplete') return 'uncomplete';
  return null;
}

/** Change versus ops can still be flipped (ADR-0020): an AI task that has not started. */
export function opsEditable(task: ActionSubject): boolean {
  return UNSTARTED_AI(task);
}
