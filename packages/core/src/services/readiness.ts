import type { Task } from '../models/Task';
import type { PlanStore } from './PlanStore';
import type { IsolationRunController } from './IsolationRunController';
import { classifyAttempt, mergeExcludes } from './attemptKind';

/** What the scheduler may read to decide what runs: read-only plan state, the holds, and the open isolated run. */
export interface ReadinessInput {
  store: Pick<PlanStore, 'allTasks' | 'isCompleted' | 'isFailed' | 'isOps'>;
  /** Task ids pulled out of auto-scheduling (cancelled, or a spawn that failed). */
  onHold: ReadonlySet<string>;
  /**
   * The open isolated run's records — `openRecord` answers undefined for a
   * shared-root run — and which landed work still waits to be merged into
   * the user's branch.
   */
  runs: Pick<IsolationRunController, 'openRecord' | 'awaitsMerge'>;
  /** Attempts already holding a slot. */
  active: number;
  maxParallel: number;
  /** A Merge all is under way, so no work it excludes may start (ADR-0020). */
  merging?: boolean;
}

/** One AI task the gates held back, with why, for the scheduler's log. */
export interface ReadyTaskExclusion {
  task: Readonly<Task>;
  reasons: string[];
}

export interface Readiness {
  /** The tasks to start, lowest order first, capped at the free slots. */
  ready: Task[];
  /** How many tasks passed every gate, before the slot cap. */
  candidateCount: number;
  /** AI tasks with a prompt the gates held back, with why. Empty when the slots are full. */
  excluded: ReadyTaskExclusion[];
  /** Ops tasks held back by nothing but their merge gate. */
  gated: Task[];
}

/**
 * The scheduler's readiness rule as one pure function over the plan and the
 * holds: an AI task with a prompt is ready while it is pending or approved,
 * off hold, unblocked, and every dependency's work is on the integration
 * branch. An ops task also waits at its merge gate, and while a Merge all is
 * under way (ADR-0020). `active` is the slots already taken, so no more than
 * `maxParallel` run at once.
 */
export function selectReadyTasks(input: ReadinessInput): Readiness {
  const { store, onHold, runs, active, maxParallel } = input;
  if (active >= maxParallel) return { ready: [], candidateCount: 0, excluded: [], gated: [] };
  const availableSlots = maxParallel - active;

  const gated: Task[] = [];
  const candidates = store.allTasks.filter((t) => {
    if (t.status !== 'pending' && t.status !== 'approved') return false;
    if (t.type === 'user') return false;
    if (!t.prompt) return false;
    if (onHold.has(t.id)) return false;
    if (isBlocked(t, store)) return false;
    if (!t.dependencies.every((depId) => dependencyMet(depId, store, runs))) return false;
    if (heldByMerge(t, input)) return false;
    if (mergeGate(t, store, runs).length > 0) {
      gated.push(t);
      return false;
    }
    return true;
  });

  const excluded = store.allTasks
    .filter((t) => t.type === 'ai' && t.prompt && !candidates.includes(t))
    .map((task) => ({ task, reasons: exclusionReasons(task, input) }));

  return {
    ready: candidates.sort((a, b) => a.order - b.order).slice(0, availableSlots),
    candidateCount: candidates.length,
    excluded,
    gated,
  };
}

/** A task is blocked when it was parked as blocked, or a dependency of it failed. */
export function isBlocked(task: Readonly<Task>, store: Pick<PlanStore, 'isFailed'>): boolean {
  if (task.status === 'blocked') return true;
  if (task.dependencies.length > 0) return task.dependencies.some((depId) => store.isFailed(depId));
  return false;
}

/**
 * In an isolated run a dependency is met once its work is on the integration
 * branch, not merely once it passed: the dependent's worktree is cut from that
 * branch, so starting earlier would hand it a tree without the work it depends
 * on.
 */
export function dependencyMet(
  depId: string,
  store: Pick<PlanStore, 'isCompleted'>,
  runs: Pick<IsolationRunController, 'openRecord'>,
): boolean {
  if (!store.isCompleted(depId)) return false;
  const record = runs.openRecord(depId);
  return !record || record.status === 'merged';
}

/**
 * The merge gate (ADR-0020): the completed dependencies of a task that runs
 * outside a worktree — an ops task or a user task — whose landed work is not
 * in the user's branch yet. What it acts on, or what the user checks by hand,
 * is their checkout, which does not hold that work until it is merged. Empty
 * for a change task, and for any task of a run that never isolated.
 */
export function mergeGate(
  task: Readonly<Task>,
  store: Pick<PlanStore, 'isCompleted' | 'isOps'>,
  runs: Pick<IsolationRunController, 'awaitsMerge'>,
): string[] {
  if (task.type !== 'user' && !store.isOps(task.id)) return [];
  return task.dependencies.filter((depId) => store.isCompleted(depId) && runs.awaitsMerge(depId));
}

function exclusionReasons(task: Readonly<Task>, input: ReadinessInput): string[] {
  const { store, onHold, runs } = input;
  const reasons: string[] = [];
  if (task.status !== 'pending' && task.status !== 'approved') reasons.push(`status=${task.status}`);
  if (onHold.has(task.id)) reasons.push('on-hold');
  if (isBlocked(task, store)) reasons.push('blocked');
  if (!task.dependencies.every((depId) => dependencyMet(depId, store, runs))) reasons.push('deps');
  if (mergeGate(task, store, runs).length > 0) reasons.push('merge-gate');
  if (heldByMerge(task, input)) reasons.push('merging');
  return reasons;
}

/** A Merge all under way holds back the work it excludes (ADR-0020). */
function heldByMerge(task: Readonly<Task>, input: ReadinessInput): boolean {
  return input.merging === true && mergeExcludes(classifyAttempt(input.store.isOps(task.id)));
}
