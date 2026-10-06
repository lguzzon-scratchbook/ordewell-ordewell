/**
 * A request on the plan the session refused: a direct (non-planner) edit that
 * is not valid, or an isolation action on a plan with no isolated run to act
 * on. Distinct from a plain Error so a surface can tell "you asked for
 * something invalid" from "something broke" and say which — the HTTP routes
 * used to collapse both into 404/500, which read to the TUI and VS Code as the
 * edit silently doing nothing. Carries no status code: core is
 * transport-agnostic, the route maps it.
 */
export class PlanEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanEditError';
  }
}
