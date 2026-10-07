/**
 * Browser-safe entry point: pure plan-validation utilities with no Node or
 * AI-service dependencies. UI surfaces (the VS Code webview runs in a browser)
 * import runtime values from here instead of the main barrel, which bundles the
 * Gemini/OpenAI services and their `fs`/`child_process` imports.
 */
export { canMergeTasks, canSplitTask, canSetDependencies, dependencyCandidates, dependentsOf } from './services/TaskOps';
export type { TaskRef } from './services/TaskOps';
export { summarizeToolCall } from './services/researchStepSummary';
export { truncateCheckpointSummary, CHECKPOINT_TRUNCATE_LENGTH } from './services/SessionMessage';
export { capConflictFiles } from './services/conflictFiles';
// The shared conversation view (#51) is pure too, so every surface — a webview
// included — draws from the same reducer.
export * from './conversation';
// The task row view is pure for the same reason: the webview draws a task card
// from the facts the TUI paints its plan row from.
export * from './taskRow';
export { taskOrderLabel, taskRef, titledTaskRef } from './order-labels';
// The one runner default, shared with the webview so its initial state cannot
// drift from the plans the host builds.
export { DEFAULT_RUNNERS } from './models/Task';
