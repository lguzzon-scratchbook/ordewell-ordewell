import type { ApprovalDecision, AwaitingReason, DisplayBlock, StructuredTurnEnd, TaskStatus } from '@ordewell/core';

/*
 * The messages between the extension host and a task-log panel (ADR-0018, V1).
 * Types only: the host (tsup) and the panel (Vite) each compile this file, so
 * neither can drift from what the other sends. The panel is its own webview —
 * one editor tab per task — so it has its own protocol rather than borrowing
 * the chat's, which is shaped around the planner conversation.
 */

/** One message a structured task's runner has not read yet. */
export interface TaskLogQueuedMessage {
  id: string;
  text: string;
  /** The runner already has it, for its next step, so it cannot be taken back (ADR-0023). */
  handedOver?: boolean;
  /** Force sent: it goes as soon as the running turn is interrupted (ADR-0023, F1). */
  forced?: boolean;
}

/**
 * Everything the panel draws besides the log blocks: the header's identity and
 * live state, the attempt switcher, and the composer's queue. Derived on the
 * host from the reduced view and the task, so the panel never has to know the
 * plan.
 */
export interface TaskLogStatus {
  taskId: string;
  order: number;
  title: string;
  runner: string;
  planStatus: TaskStatus;
  awaitingReason?: AwaitingReason;
  /** How many of the runner's tool requests wait for an answer (ADR-0018, A1). */
  awaitingApproval: number;
  /** A turn is live. */
  working: boolean;
  /** How the last turn ended; absent before the first one does. */
  lastTurnEnd?: StructuredTurnEnd;
  /** Messages the runner has not read yet, oldest first. */
  queued: readonly TaskLogQueuedMessage[];
  /** Attempts that have a saved log, oldest first. */
  attempts: readonly number[];
  /** Which attempt the blocks below belong to. */
  attempt: number;
  /** The task finished and can be continued in its saved session (ADR-0018, K1): the message box continues it. */
  continuable: boolean;
}

export type HostToTaskLog =
  /** The panel opened, or switched attempt: the whole view it should draw. */
  | { type: 'init'; status: TaskLogStatus; blocks: readonly DisplayBlock[] }
  /** Blocks new or changed since the last patch, with the new order. */
  | { type: 'patch'; order: readonly string[]; changed: readonly DisplayBlock[] }
  /** The header or queue changed; the blocks did not. */
  | { type: 'status'; status: TaskLogStatus }
  | { type: 'showError'; error: string };

export type TaskLogToHost =
  | { type: 'ready' }
  | { type: 'sendTaskMessage'; text: string }
  | { type: 'removeQueuedTaskMessage'; id: string }
  /** Force send (ADR-0023, F1): interrupt the running turn and deliver `text` next. */
  | { type: 'sendTaskMessageNow'; text: string }
  /** Force send a message still queued. */
  | { type: 'sendQueuedTaskMessageNow'; id: string }
  | { type: 'interruptTask' }
  /** Continue the finished task in its saved session, with `text` as its next turn. */
  | { type: 'continueTask'; text: string }
  /** Answer one of the runner's tool requests (ADR-0018, A1). */
  | { type: 'answerApproval'; id: string; decision: ApprovalDecision }
  /** Show an earlier attempt; the host answers with `init`. */
  | { type: 'selectAttempt'; attempt: number };
