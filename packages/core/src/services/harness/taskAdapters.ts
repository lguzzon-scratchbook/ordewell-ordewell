import { TaskModeUnsupportedError, type AgentProcessDeps, type TaskModeAgentAdapter } from './AgentAdapter';
import { ClaudeCodeAdapter } from './ClaudeCodeAdapter';
import { CodexAdapter } from './CodexAdapter';
import { OpenCodeAdapter } from './OpenCodeAdapter';

/** The runners with a task-mode connector (ADR-0018, S3). */
const TASK_MODE_ADAPTERS: Record<string, (deps: AgentProcessDeps) => TaskModeAgentAdapter> = {
  'claude-code': (deps) => new ClaudeCodeAdapter(deps),
  codex: (deps) => new CodexAdapter(deps),
  opencode: (deps) => new OpenCodeAdapter(deps),
};

/** The connectors that hand their runner the Ordewell MCP server (ADR-0022). */
const ORDEWELL_TOOL_RUNNERS = new Set(['claude-code', 'codex']);

/** Whether a runner's tasks can run on the structured transport. */
export function supportsTaskMode(runner: string): boolean {
  return Object.hasOwn(TASK_MODE_ADAPTERS, runner);
}

/** Whether a structured task on this runner is given the Ordewell task tools. */
export function takesOrdewellTools(runner: string): boolean {
  return ORDEWELL_TOOL_RUNNERS.has(runner);
}

/** The adapter that drives one task. Throws {@link TaskModeUnsupportedError} for a runner without a connector. */
export function createTaskAdapter(runner: string, deps: AgentProcessDeps): TaskModeAgentAdapter {
  if (!supportsTaskMode(runner)) throw new TaskModeUnsupportedError(runner);
  return TASK_MODE_ADAPTERS[runner](deps);
}
