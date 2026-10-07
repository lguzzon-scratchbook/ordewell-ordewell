import type { PlannerModelRecall, SettingsUpdateResponse } from '@ordewell/core';

/**
 * What a planner-switch response settled on, for the surface to word.
 *
 * The daemon decides this and says so (`switchRecall`), but only when the write
 * actually changed the planner. Reselecting the one already in use keeps its
 * model — the one it remembers, since every pick is remembered — so the
 * response's own model and effort are the answer, worded as a restore.
 */
export function plannerSwitchRecall(settings: SettingsUpdateResponse): PlannerModelRecall {
  if (settings.switchRecall) return settings.switchRecall;
  const model = settings.orchestratorModel;
  return model
    ? { model, effort: settings.plannerThinkingEffort, source: 'remembered' }
    : { model: '', effort: '', source: 'none' };
}
