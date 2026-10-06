import type { AwaitingReason } from '../models/Task';
import type { TaskIsolationState } from '../interfaces/IWorktreeIsolation';
import { taskOrderLabel, taskRef } from '../order-labels';
import { capConflictFiles } from '../services/conflictFiles';
import { approvalLabel, awaitingLabel, isTaskRunning, taskStatusKind, type TaskStatusKind } from './status';
import { markAction, opsEditable, taskRowActions, type TaskRowAction, type TaskRowPlacement } from './actions';

/**
 * A task as both surfaces hold it, with the live state each tracks beside it
 * (silence, approvals, isolation, the merge gate). Structural, because the TUI
 * projects tasks into its own shape.
 */
export interface TaskRowSubject {
  id: string;
  order: number;
  type: 'ai' | 'user';
  status: string;
  dependencies: readonly string[];
  taskMode?: string;
  ops?: boolean;
  idleSince?: string | null;
  awaitingReason?: AwaitingReason;
  awaitingApproval?: number;
  isolation?: TaskRowIsolation | null;
  mergeGate?: readonly string[];
  forcedPastGate?: readonly string[];
}

export interface TaskRowIsolation {
  state: TaskIsolationState;
  repos?: string[];
  conflictRepo?: string;
  conflictFiles?: string[];
  repair?: { attempt: number; limit: number };
  repairedFiles?: string[];
}

export interface TaskRowContext {
  /** Set for a subtask: it is labelled by its dotted order. */
  parent?: { order: number } | null;
  /** Which action set the row offers; a row with a parent is a subtask's unless told otherwise. */
  placement?: TaskRowPlacement;
  /** Order of each task a dependency or gate may name; one missing from it is shown by id. */
  orderOf?: ReadonlyMap<string, number>;
  /** The modes the task's runner declares; autonomy is a tag on one of them (ADR-0001). */
  modes?: readonly { id: string; autonomous?: boolean }[];
}

/** Whether the row stands for an AI task, a manual one, or an ops task (ADR-0020). */
export type TaskRowKind = 'ai' | 'user' | 'ops';

export interface TaskRowView {
  /** "2", or "2.1" for a subtask. */
  orderLabel: string;
  kind: TaskRowKind;
  status: TaskStatusKind;
  /** A runner is live behind it — `quiet` included. */
  running: boolean;
  /** What an awaiting task waits on, in sentence case; null when nothing was saved. */
  awaiting: string | null;
  /** Runner requests waiting on the user, in sentence case; null when none do. */
  approvals: string | null;
  /** The task's mode is tagged autonomous: it runs without permission prompts. */
  autonomous: boolean;
  /** The repos its isolated work changed, by path; empty for a group of one. */
  repos: string[];
  /** Integration stopped on a conflict: the one isolation state that needs the user. */
  conflict: { repo: string | null; files: string | null } | null;
  /** A conflict repair in flight (ADR-0015) — progress, not a blocker. */
  repairing: { files: string | null; attempt: { attempt: number; limit: number } | null } | null;
  /** The files a conflict repair was started for; `landed` once the task is integrated. */
  repaired: { files: string; landed: boolean } | null;
  /** The dependencies, by reference, whose work is not merged into the user's branch yet. */
  mergeGate: string[] | null;
  /** An ops task changed tracked files in the user's checkout and nothing was committed. */
  opsChangedFiles: boolean;
  /** The dependencies, by title, a force start went past the merge gate of. */
  forcedPastGate: readonly string[] | null;
  /** The task's dependencies, by reference. */
  dependencies: string[];
  /** What the row offers while a plan runs. */
  actions: TaskRowAction[];
  /** The one mark its toggle sets. */
  mark: 'complete' | 'uncomplete';
  opsEditable: boolean;
}

const refsOf = (ids: readonly string[], orderOf: ReadonlyMap<string, number> | undefined): string[] =>
  ids.map((id) => {
    const order = orderOf?.get(id);
    return order === undefined ? id : taskRef({ order });
  });

/** A lone repository at the workspace root is not named: a group of one reads as it did before repo groups. */
const namedRepo = (repo: string | undefined): string | null => (repo && repo !== '.' ? repo : null);

/** The repos a task changed, for a row that names them; none for a group of one. */
export const namedRepos = (repos: readonly string[] | undefined): string[] => (repos ?? []).filter((r) => r !== '.');

const filesOf = (files: string[] | undefined): string | null => (files?.length ? capConflictFiles(files) : null);

/**
 * Everything a plan row says about one task, decided once: each surface picks
 * its own words, glyphs and casing for these facts, and derives none of them.
 */
export function taskRowView(task: TaskRowSubject, context: TaskRowContext = {}): TaskRowView {
  const parent = context.parent ?? undefined;
  const isolation = task.isolation && task.isolation.state !== 'none' ? task.isolation : null;
  return {
    orderLabel: taskOrderLabel(task, parent),
    kind: task.type === 'user' ? 'user' : task.ops ? 'ops' : 'ai',
    status: taskStatusKind(task),
    running: isTaskRunning(task),
    awaiting: awaitingLabel(task),
    approvals: approvalLabel(task.awaitingApproval),
    autonomous: task.type === 'ai' && context.modes?.find((m) => m.id === task.taskMode)?.autonomous === true,
    repos: namedRepos(isolation?.repos),
    conflict: isolation?.state === 'conflict'
      ? { repo: namedRepo(isolation.conflictRepo), files: filesOf(isolation.conflictFiles) }
      : null,
    repairing: isolation?.state === 'repairing'
      ? { files: filesOf(isolation.conflictFiles), attempt: isolation.repair ?? null }
      : null,
    repaired: isolation?.repairedFiles?.length
      ? { files: capConflictFiles(isolation.repairedFiles), landed: isolation.state === 'integrated' }
      : null,
    mergeGate: task.mergeGate?.length ? refsOf(task.mergeGate, context.orderOf) : null,
    opsChangedFiles: task.status === 'awaiting_user' && task.awaitingReason === 'files-changed',
    forcedPastGate: task.forcedPastGate?.length ? task.forcedPastGate : null,
    dependencies: refsOf(task.dependencies, context.orderOf),
    actions: taskRowActions(task, context.placement ?? (parent ? 'subtask' : 'task')),
    mark: markAction(task),
    opsEditable: opsEditable(task),
  };
}
