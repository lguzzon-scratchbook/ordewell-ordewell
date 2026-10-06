import type { Task } from './models/Task';

/**
 * Parent-scoped dotted order label for a task, e.g. "2.1" for the first subtask
 * of task 2. Kept in its own module (no Node imports) so a browser-bundled
 * surface — the VS Code webview — can import it via `@ordewell/core/order-labels`
 * without dragging the rest of core in.
 */
export function taskOrderLabel(task: { order: number }, parent?: { order: number }): string {
  return parent ? `${parent.order}.${task.order}` : String(task.order);
}

/** How a surface refers to a task in prose: "#2", or "#2.1" for a subtask. */
export function taskRef(task: { order: number }, parent?: { order: number }): string {
  return `#${taskOrderLabel(task, parent)}`;
}

/** A task named in full, as a confirmation or a picker title does: "#2 Deploy". */
export function titledTaskRef(task: { order: number; title: string }, parent?: { order: number }): string {
  return `${taskRef(task, parent)} ${task.title}`;
}

/** Resolve a dotted label to a task in a plan's top-level task list. */
export function resolveOrderLabel(tasks: Task[], label: string): Task | undefined {
  const parts = label.split('.');
  if (parts.length > 2 || parts.some((p) => !/^\d+$/.test(p))) return undefined;
  const [topOrder, childOrder] = parts.map(Number);
  const top = tasks.find((t) => t.order === topOrder);
  if (!top) return undefined;
  if (childOrder === undefined) return top;
  return top.subtasks.find((s) => s.order === childOrder);
}