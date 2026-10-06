import { capConflictFiles, describeMergeResult, namedRepos, type IsolationMergeResult } from '@ordewell/core';
import type { HandoffRepoView, HandoffView, LandedTaskView, TaskIsolationView } from './tui/state';

/**
 * What a saved plan says about its isolated run, in the shape the surfaces show.
 * The daemon persists the run record with the plan (`LegacyPlanState.isolation`),
 * so a reloaded session can offer its handoff and mark its conflicts without a
 * live stream having told it. `null` when the payload carries no record — a
 * planner reply, or a plan that never isolated — which says nothing either way.
 */
export interface PlanIsolationView {
  handoff: HandoffView;
  tasks: Record<string, TaskIsolationView>;
}

const STATE_OF: Record<string, TaskIsolationView['state']> = {
  active: 'active',
  merged: 'integrated',
  conflict: 'conflict',
  repairing: 'repairing',
  // A failed integration keeps its refs exactly as a failed verdict does; the
  // user sees one thing: work that did not land and can be looked at.
  kept: 'kept',
  failed: 'kept',
};

interface RunRecord {
  taskId?: unknown;
  order?: unknown;
  title?: unknown;
  branch?: unknown;
  workspace?: unknown;
  /** ADR-0013 records named the one worktree here. */
  worktree?: unknown;
  status?: unknown;
  repos?: Record<string, { changed?: unknown }>;
  conflictRepo?: unknown;
  conflictFiles?: unknown;
  repairedFiles?: unknown;
  /** Its work is in the user's branch already, merged at a merge gate (ADR-0020). */
  inHead?: unknown;
}

type RepoFields = Omit<HandoffRepoView, 'landed'>;

/**
 * The run's repos. A run in the ADR-0013 shape — its one repository's refs on
 * the run itself — comes from a daemon older than this CLI and reads as a
 * group of one.
 */
function reposOf(run: Record<string, unknown>): RepoFields[] | null {
  if (Array.isArray(run.repos)) {
    const repos = (run.repos as Array<Record<string, unknown>>).filter((r) => (
      r && typeof r.path === 'string' && typeof r.integrationBranch === 'string' && typeof r.baseRef === 'string'
    ));
    return repos.length > 0
      ? repos.map((r) => ({ path: String(r.path), integrationBranch: String(r.integrationBranch), baseRef: String(r.baseRef) }))
      : null;
  }
  if (typeof run.integrationBranch === 'string' && typeof run.baseRef === 'string') {
    return [{ path: '.', integrationBranch: run.integrationBranch, baseRef: run.baseRef }];
  }
  return null;
}

function changedRepos(record: RunRecord, legacy: boolean, state: TaskIsolationView['state']): string[] {
  if (legacy) return state === 'integrated' ? ['.'] : [];
  return Object.entries(record.repos ?? {}).filter(([, r]) => r?.changed === true).map(([path]) => path);
}

export function isolationOfPlan(plan: unknown): PlanIsolationView | null {
  const run = (plan as { isolation?: { run?: Record<string, unknown> } } | null)?.isolation?.run;
  const repos = run ? reposOf(run) : null;
  if (!run || !repos) return null;
  const legacy = !Array.isArray(run.repos);

  const records = Object.entries((run.tasks ?? {}) as Record<string, RunRecord>);
  const tasks: Record<string, TaskIsolationView> = {};
  const landed: Array<LandedTaskView & { changed: string[] }> = [];
  for (const [taskId, record] of records) {
    const state = STATE_OF[String(record.status)];
    if (!state) continue;
    const changed = changedRepos(record, legacy, state);
    const repairedFiles = Array.isArray(record.repairedFiles) && record.repairedFiles.length > 0
      ? record.repairedFiles.map(String)
      : undefined;
    tasks[taskId] = {
      state,
      branch: String(record.branch ?? ''),
      worktree: String(record.workspace ?? record.worktree ?? ''),
      repos: changed,
      ...(typeof record.conflictRepo === 'string' ? { conflictRepo: record.conflictRepo } : legacy && state === 'conflict' ? { conflictRepo: '.' } : {}),
      ...(Array.isArray(record.conflictFiles) && record.conflictFiles.length > 0 ? { conflictFiles: record.conflictFiles.map(String) } : {}),
      // No `repair` (attempt/limit): `conflictRepairAttempts` is server config, never
      // sent in a persisted plan, so it cannot be reconstructed here. A live
      // `tasksStatus` update fills it in once the stream catches up.
      ...(repairedFiles ? { repairedFiles } : {}),
    };
    if (state === 'integrated' && record.inHead !== true) {
      landed.push({ taskId, order: Number(record.order ?? 0), title: String(record.title ?? taskId), changed, ...(repairedFiles ? { repairedFiles } : {}) });
    }
  }
  landed.sort((a, b) => a.order - b.order);
  const entry = ({ taskId, order, title, repairedFiles }: LandedTaskView): LandedTaskView => (
    { taskId, order, title, ...(repairedFiles ? { repairedFiles } : {}) }
  );
  return {
    handoff: {
      repos: repos.map((repo) => ({ ...repo, landed: landed.filter((t) => t.changed.includes(repo.path)).map(entry) })),
      landed: landed.map(entry),
    },
    tasks,
  };
}

/** The run's integration branch as one line names it: every repo's has the same name. */
export function handoffBranch(handoff: HandoffView): string {
  return [...new Set(handoff.repos.map((r) => r.integrationBranch))].join(', ');
}

/** Where the run forked, as one line names it, each ref cut to `length` and, for a group, headed by its repo. */
export function handoffBase(handoff: HandoffView, length: number): string {
  const group = isRepoGroup(handoff);
  return handoff.repos.map((r) => `${group ? `${r.path} ` : ''}${r.baseRef.slice(0, length)}`).join(', ');
}

/**
 * Whether the run spans more than a lone repo at the workspace root. A group of
 * one at `.` is worded and drawn exactly as it was before repo groups; anything
 * else names its repos.
 */
export function isRepoGroup(handoff: HandoffView): boolean {
  return handoff.repos.some((r) => r.path !== '.');
}

/** The repos Merge all will merge: those with work on their integration branch, else all of them. */
export function reposWithWork(handoff: HandoffView): string[] {
  const withWork = handoff.repos.filter((r) => r.landed.length > 0);
  return (withWork.length > 0 ? withWork : handoff.repos).map((r) => r.path);
}

/** Landed tasks that only landed after a conflict repair (ADR-0015). */
export function repairedLanded(handoff: HandoffView): LandedTaskView[] {
  return handoff.landed.filter((t) => t.repairedFiles?.length);
}

/**
 * So a reviewer knows where to look before confirming Merge all (ADR-0015): a
 * leading-space sentence naming every landed task that only landed after a
 * conflict repair, and its files — empty when none did.
 */
export function repairedNotice(handoff: HandoffView): string {
  const repaired = repairedLanded(handoff);
  if (repaired.length === 0) return '';
  const named = repaired.map((t) => `${t.title} (${capConflictFiles(t.repairedFiles!)})`);
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return ` ${list} landed through ${repaired.length === 1 ? 'a conflict repair' : 'conflict repairs'}.`;
}

/** One line per repo: what landed on its integration branch, or that there is nothing to merge. */
export function repoResultLines(handoff: HandoffView): string[] {
  return handoff.repos.map(({ path, landed }) => {
    const n = landed.length;
    return `${path}: ${n === 0 ? 'nothing to merge' : `${n} task${n === 1 ? '' : 's'} landed`}`;
  });
}

export function taskRepoNames(isolation: TaskIsolationView | undefined): string[] {
  return namedRepos(isolation?.repos);
}

/**
 * What "Merge all" did, in words. A group of one reads as it did before repo
 * groups; a group takes the shared wording and, when nothing or not everything
 * merged, is told the integration branches are plain branches to merge by hand.
 */
export function mergeOutcome(
  result: IsolationMergeResult,
  branch: string,
  group: boolean,
  repaired: LandedTaskView[] = [],
): { ok: boolean; message: string } {
  const ok = result.outcome === 'merged';
  if (!group && result.outcome === 'conflict') {
    return { ok, message: `Merging ${branch} conflicted, so it was aborted — your tree is as it was. Merge it with git and resolve the conflict there.` };
  }
  const { message } = describeMergeResult(result, branch, group, repaired);
  return { ok, message: ok || !group ? message : `${message} Each repository's ${branch} is a plain branch you can merge by hand.` };
}
