import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  AlreadyExecutingError,
  ConversationBusyError,
  ConversationEditError,
  NoPlanError,
  PlanEditError,
  PlannerTurnDiscardedError,
  PlannerTurnStoppedError,
  SessionNotFoundError,
  TaskControlError,
  WorkspaceNotAProjectError,
  WorkspaceNotFoundError,
  type DaemonErrorCode,
  type ErrorBody,
} from '@ordewell/core';

interface Classified {
  status: ContentfulStatusCode;
  code: DaemonErrorCode;
}

/**
 * The one table from a thrown class to a status and a stable code. A refusal is
 * the request being wrong (400) or arriving at a bad moment (409), a missing
 * session is 404, and only what falls through is a fault — collapsing these
 * into 404/500 gave the TUI and VS Code nothing to show but "Internal error",
 * which reads as the edit having silently done nothing.
 *
 * Order matters: `ConversationBusyError` extends `ConversationEditError`.
 */
function classify(err: unknown): Classified | undefined {
  if (err instanceof SessionNotFoundError) return { status: 404, code: 'session_not_found' };
  if (err instanceof NoPlanError) return { status: 400, code: 'no_plan' };
  if (err instanceof AlreadyExecutingError) return { status: 409, code: 'already_executing' };
  if (err instanceof WorkspaceNotAProjectError) return { status: 400, code: 'workspace_not_a_project' };
  if (err instanceof WorkspaceNotFoundError) return { status: 400, code: 'workspace_not_found' };
  // 409, not 5xx: the turn ending is what the user asked for (or a plan they
  // dropped), and a 5xx would log a stack for every Stop.
  if (err instanceof PlannerTurnStoppedError) return { status: 409, code: 'planner_turn_stopped' };
  if (err instanceof PlannerTurnDiscardedError) return { status: 409, code: 'planner_turn_discarded' };
  if (err instanceof ConversationBusyError) return { status: 409, code: 'conversation_busy' };
  if (err instanceof ConversationEditError || err instanceof PlanEditError || err instanceof TaskControlError) {
    return { status: 400, code: 'refused' };
  }
  return undefined;
}

/** A refusal the route itself decided on, in the body shape every client reads. */
export function refuse(c: Context, status: ContentfulStatusCode, message: string, code?: DaemonErrorCode) {
  const body: ErrorBody = code ? { error: message, code } : { error: message };
  return c.json(body, status);
}

/**
 * A JSON error response from a thrown call. What `classify` does not know is a
 * fault and takes the route's `fallback` status; only a 5xx is logged, since a
 * refusal is the request being wrong and travels to the client as-is.
 */
export function failure(
  c: Context,
  err: unknown,
  label: string,
  { fallback = 500, message = 'Internal error' }: { fallback?: ContentfulStatusCode; message?: string } = {},
) {
  const classified = classify(err);
  const status = classified?.status ?? fallback;
  // Log before returning: the message alone travels to the client, so an
  // unexpected throw (a research tool crashing the whole turn, say) left no
  // stack anywhere — server.log showed nothing and the CLI showed one line.
  if (status >= 500) console.error(`[web] ${label} failed:`, err);
  const body: ErrorBody = {
    error: (err instanceof Error && err.message) || message,
    ...(classified ? { code: classified.code } : {}),
    ...(err instanceof WorkspaceNotAProjectError ? { workspace: err.workspace } : {}),
  };
  return c.json(body, status);
}
