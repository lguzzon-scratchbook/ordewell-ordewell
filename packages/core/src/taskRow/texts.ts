import { titledTaskRef } from '../order-labels';

interface Named {
  id: string;
  order: number;
  title: string;
  subtasks?: readonly Named[];
}

function findNamed(tasks: readonly Named[], id: string): Named | undefined {
  for (const task of tasks) {
    if (task.id === id) return task;
    const nested = findNamed(task.subtasks ?? [], id);
    if (nested) return nested;
  }
  return undefined;
}

/** Each id as "#N title", subtasks included; one the plan no longer holds stays a bare id. */
export function titledRefs(ids: readonly string[], tasks: readonly Named[]): string[] {
  return ids.map((id) => {
    const task = findNamed(tasks, id);
    return task ? titledTaskRef(task) : id;
  });
}

/**
 * What removing a task does to the tasks that depend on it, or null when none
 * do. Named rather than counted: the removal rewrites their dependency lists,
 * and a bare "Remove task?" would hide that.
 */
export function dependentsNotice(dependents: readonly { order: number; title: string }[]): string | null {
  if (dependents.length === 0) return null;
  const subject = dependents.length === 1 ? '1 task depends' : `${dependents.length} tasks depend`;
  return `${subject} on it and will lose that dependency: ${dependents.map((t) => titledTaskRef(t)).join(', ')}.`;
}

/**
 * What a start past a merge gate is asked with (ADR-0020): the work the task
 * would act without, named. `subject` is how the asking surface refers to the
 * task — "It" under a title that already names it.
 */
export function pastGateConfirmation(unmerged: readonly string[], subject = 'This task'): string {
  return `${subject} waits for Merge all: the work of ${unmerged.join(', ')} is not merged into your branch yet, so it would act without it. Starting it now is kept on the task.`;
}

export interface NewTaskFields {
  title: string;
  description: string;
  prompt: string;
  type: 'ai';
}

/**
 * What a hand-added task starts as: an AI task whose description is its title
 * and whose prompt, unless one was typed, is too. Null for a title with nothing
 * in it, rather than a nameless task. Assignments are left for the session to
 * derive from the runner's catalog.
 */
export function newTaskFields(title: string, prompt?: string): NewTaskFields | null {
  const name = title.trim();
  if (!name) return null;
  return { title: name, description: name, prompt: prompt?.trim() ? prompt : name, type: 'ai' };
}
