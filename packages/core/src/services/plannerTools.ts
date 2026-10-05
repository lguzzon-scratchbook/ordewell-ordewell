import { flattenTasks, type RunnerId, type Task } from '../models/Task';
import { autonomyLevelLabel, filteredBuildModes, resolveDefaultMode } from './ModeResolver';
import { validatePlanTasks } from './PlanValidator';
import type { TaskQueryCatalog } from './TaskQuery';
import type { McpToolReply, PlannerToolHandler } from './mcp';

/**
 * The session side of the planner's catalog and submission tools (ADR-0022):
 * every answer is read from live state at the call, so what the planner plans
 * against is what its submission is checked against (L2, L3).
 */
export interface PlannerToolsHost {
  /** Enabled runners, their modes and their allowlisted models, as of now. */
  liveCatalog(): Promise<TaskQueryCatalog>;
  /** The assignments a commit of these tasks would land, under the allowlist in force (ADR-0003). */
  coerce(tasks: readonly Task[], runners: RunnerId[]): Task[];
  /** Hand a validated plan to the open planner turn. False when no turn is open. */
  submitPlan(tasks: Task[], runners: RunnerId[]): boolean;
}

/** A change the commit makes to a submitted task, named so it is never silent (ADR-0001). */
interface Coercion {
  taskId: string;
  field: 'assignedRunner' | 'assignedModel' | 'thinkingEffort';
  from: string | null;
  to: string | null;
}

export function plannerToolHandler(host: PlannerToolsHost): PlannerToolHandler {
  return {
    async listRunners() {
      const catalog = await host.liveCatalog();
      return answer({
        autonomy: autonomyLevelLabel(catalog.autonomousDefault),
        runners: catalog.runners.map((id) => {
          const modes = catalog.modes[id] ?? [];
          // The modes the system prompt has always offered: those the
          // autonomy level allows, and `plan` for analysis-only work.
          const offered = [...filteredBuildModes(modes, catalog.autonomousDefault), ...modes.filter((m) => m.id === 'plan')];
          return {
            id,
            defaultMode: resolveDefaultMode(modes, catalog.autonomousDefault) ?? null,
            modes: offered.map(({ id: modeId, label, description }) => ({ id: modeId, label, description })),
          };
        }),
      });
    },

    async listModels({ runner }) {
      const catalog = await host.liveCatalog();
      if (!catalog.runners.includes(runner)) return notEnabled(runner, catalog.runners);
      return answer({
        runner,
        models: (catalog.models[runner] ?? []).map((m) => ({
          modelId: m.modelId,
          modelLabel: m.modelLabel,
          variants: (m.variants ?? []).map((v) => ({ id: v.id, label: v.label })),
        })),
      });
    },

    async submitPlan({ tasks }) {
      const catalog = await host.liveCatalog();
      const result = validatePlanTasks({ tasks }, catalog.runners, catalog.modes, catalog.autonomousDefault);
      if (!result.ok) return { isError: true, text: JSON.stringify({ ok: false, errors: result.errors, enabledRunners: catalog.runners }) };

      const runners = [...new Set(flattenTasks(result.tasks).filter((t) => t.type !== 'user').map((t) => t.assignedRunner))];
      const coerced = coercions(result.tasks, host.coerce(result.tasks, runners));
      if (!host.submitPlan(result.tasks, runners)) {
        return { isError: true, text: JSON.stringify({ ok: false, errors: [{ field: 'tasks', message: 'No planning turn is open to take the plan.' }] }) };
      }
      return answer({
        ok: true,
        tasks: result.tasks.length,
        coerced,
        next: 'The plan is committed when this reply ends. Tell the user briefly what you submitted; do not repeat the plan as JSON.',
      });
    },
  };
}

function answer(body: unknown): McpToolReply {
  return { text: JSON.stringify(body) };
}

function notEnabled(runner: string, enabled: RunnerId[]): McpToolReply {
  return { isError: true, text: `Runner "${runner}" is not enabled. Enabled runners: ${enabled.join(', ') || '(none)'}.` };
}

function coercions(submitted: readonly Task[], landed: readonly Task[]): Coercion[] {
  return submitted.flatMap((task, i) => {
    const after = landed[i];
    const out: Coercion[] = [];
    if (after.assignedRunner !== task.assignedRunner) {
      out.push({ taskId: task.id, field: 'assignedRunner', from: task.assignedRunner, to: after.assignedRunner });
    }
    const [fromModel, toModel] = [task.assignedModel?.modelId ?? null, after.assignedModel?.modelId ?? null];
    if (fromModel !== toModel) out.push({ taskId: task.id, field: 'assignedModel', from: fromModel, to: toModel });
    const [fromEffort, toEffort] = [task.assignedModel?.thinkingEffort ?? null, after.assignedModel?.thinkingEffort ?? null];
    if (fromEffort !== toEffort) out.push({ taskId: task.id, field: 'thinkingEffort', from: fromEffort, to: toEffort });
    return out;
  });
}
