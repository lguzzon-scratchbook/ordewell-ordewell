/**
 * Why a call on a session could not be made. Each is a class rather than a
 * message so the daemon can map it to a status and a stable code in one place,
 * and a client can switch on that code instead of reading the wording. Like
 * `PlanEditError`, none carries a status: core is transport-agnostic.
 */

/** No session with that id is held — never planned in this process, or dropped by a restart. */
export class SessionNotFoundError extends Error {
  constructor() {
    super('Session not found');
    this.name = 'SessionNotFoundError';
  }
}

/** The session holds no plan (or an empty one) for the operation to act on. */
export class NoPlanError extends Error {
  constructor(operation: 'execute' | 'review') {
    super(`No plan to ${operation}`);
    this.name = 'NoPlanError';
  }
}

/** A run is already live, and starting another would reset the one in flight. */
export class AlreadyExecutingError extends Error {
  constructor() {
    super('Session already executing');
    this.name = 'AlreadyExecutingError';
  }
}
