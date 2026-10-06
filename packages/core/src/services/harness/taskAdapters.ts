import { TaskModeUnsupportedError, type AgentProcessDeps, type TaskModeAgentAdapter } from './AgentAdapter';
import { connectorFor } from './connectors';

/** Whether a runner's tasks can run on the structured transport (ADR-0018, S3). */
export function supportsTaskMode(runner: string): boolean {
  return connectorFor(runner) !== undefined;
}

/** Whether a structured task on this runner is given the Ordewell task tools (ADR-0022). */
export function takesOrdewellTools(runner: string): boolean {
  return connectorFor(runner)?.ordewellTools !== undefined;
}

/** The adapter that drives one task. Throws {@link TaskModeUnsupportedError} for a runner without a connector. */
export function createTaskAdapter(runner: string, deps: AgentProcessDeps): TaskModeAgentAdapter {
  const connector = connectorFor(runner);
  if (!connector) throw new TaskModeUnsupportedError(runner);
  return connector.create(deps);
}
