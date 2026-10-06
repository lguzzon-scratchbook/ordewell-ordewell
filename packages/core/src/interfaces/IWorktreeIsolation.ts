import type { Task } from '../models/Task';

/**
 * Why isolated execution is unavailable for a workspace. The orchestrator needs
 * the reason, not just a boolean: `dirty` is offered a stash or an explicit
 * "run without isolation", while the others fall back to the shared
 * workspace root with a one-line notice.
 */
export type IsolationInactiveReason = 'disabled' | 'git-missing' | 'not-git' | 'no-commits' | 'dirty';

/**
 * `repos` names, relative to the workspace, the repositories behind the answer:
 * when active, the ones that will isolate, with `shared` the paths every task
 * will share live — loose entries of the workspace root, or, for a lone
 * repository, the repositories nested inside it; otherwise the dirty ones of a
 * `dirty` group, or the commitless ones of a `no-commits` group. A group of one
 * names none.
 */
export type IsolationAvailability =
  | { active: true; repos?: string[]; shared?: string[] }
  | { active: false; reason: IsolationInactiveReason; repos?: string[] };

/**
 * Where a run's tasks work, as the planner is told it: the repos of the group
 * and the paths shared live between tasks. A lone repository is `['.']` with
 * nothing shared, unless it holds nested repositories, which are shared live
 * and named in `shared`.
 */
export interface RepoGroupLayout {
  repos: string[];
  shared: string[];
}

export type IsolationOutcome = 'merged' | 'conflict' | 'failed';

/**
 * `active` — worktree exists, a runner may be writing to it.
 * `kept` — released with its worktree and branch preserved for inspection.
 * `conflict` — integration stopped on a merge conflict; worktree and refs kept.
 * `repairing` — a conflict repair (ADR-0015) is working in the kept worktree;
 *   one that ends without landing leaves the task `conflict` again.
 * `failed` — integration hit a git error other than a conflict; refs kept.
 * `merged` — landed on the integration branch; worktree and task branch removed.
 */
export type IsolationTaskStatus = 'active' | 'kept' | 'conflict' | 'repairing' | 'failed' | 'merged';

/** One repo's share of a task: its worktree inside the task workspace. */
export interface IsolationTaskRepo {
  /** Absolute path of this repo's worktree: the task workspace joined with the repo's path. */
  worktree: string;
  /**
   * Paths linked from the real workspace and kept out of the task's commit:
   * the artifacts bootstrapped from the real repo, and a lone repository's
   * nested repositories (`run.shared`). Recorded because a symlink is not
   * matched by an ignore rule such as `node_modules/` and would otherwise be
   * committed.
   */
  linked: string[];
  /** Whether the task brought commits to this repo; unknown until it first integrates. */
  changed?: boolean;
  /**
   * The integration tip right after the task landed here: what the user's
   * HEAD must contain for the task's work to count as merged (ADR-0020).
   */
  landedTip?: string;
}

export interface IsolationTaskRecord {
  taskId: string;
  order: number;
  title: string;
  /** One branch name, the same in every repo, so a task is one name to look up across the group. */
  branch: string;
  /**
   * Absolute path of the task workspace, holding one worktree per repo at the
   * repo's path. The Runner's cwd is inside it when the workspace is a repo
   * subdirectory; for a group of one it is the worktree.
   */
  workspace: string;
  /** For the task as a whole: landing is atomic across the repos it changed. */
  status: IsolationTaskStatus;
  /** Keyed by repo path. */
  repos: Record<string, IsolationTaskRepo>;
  /** The repo whose merge stopped the task from landing, while `status` is `conflict` or `failed`. */
  conflictRepo?: string;
  /**
   * What a `failed` landing stopped on, in words a surface can repeat — a
   * missing worktree is the common one. Cleared by the next landing attempt,
   * so a stale reason cannot outlive the failure it explains.
   */
  landingError?: string;
  /** Repo-relative paths, in `conflictRepo`, that conflicted; set only while `status` is `conflict` or `repairing`. */
  conflictFiles?: string[];
  /**
   * Conflict repairs started for this task (ADR-0015). Counted when one starts,
   * so a crash cannot hand the spent attempt back; absent reads as none.
   */
  repairs?: number;
  /**
   * Keyed by repo path: each changed repo's integration tip when the repair in
   * flight started — what the task branch must contain before it may land.
   * Set only while `status` is `repairing`.
   */
  repairBase?: Record<string, string>;
  /**
   * Every file a repair was started for, across all of them: as `conflictFiles`
   * names it in a group of one, prefixed with its repo's path in a group.
   */
  repairedFiles?: string[];
  /**
   * Set once the task's landed work is in the checked-out HEAD of every repo
   * it changed — merged into the user's branch, by Merge all or by hand. What
   * a merge gate waits for (ADR-0020).
   */
  inHead?: true;
}

/**
 * A task's landing in flight: each changed repo's integration tip from before
 * the task's merge. On the run rather than the task record because it must
 * outlive that record — a retry drops and recreates it — until every repo is
 * back at its tip or the task has landed.
 */
export interface IsolationLanding {
  taskId: string;
  /** Keyed by repo path. */
  tips: Record<string, string>;
}

/**
 * One repository of the group (ADR-0014). Every git operation on it runs in
 * `root`, never in the workspace root.
 */
export interface IsolationRepo {
  /** Relative to the workspace root; `.` when the workspace is itself the repository. */
  path: string;
  /**
   * Absolute: the workspace root joined with `path`. For a group of one that is
   * the workspace root, which may be a subdirectory of the repository.
   */
  root: string;
  /** The commit checked out at run start. Switching branches mid-run does not retarget it. */
  baseRef: string;
  /** Branch name checked out at run start; absent on a detached HEAD. */
  baseBranch?: string;
  integrationBranch: string;
}

/**
 * One Execute-Plan click or one manual task run over the workspace's repo
 * group. Plain JSON on purpose: the orchestrator persists it with the plan
 * state so a resumed session can find its integration branches again. The
 * module mutates `tasks` in place.
 */
export interface IsolationRun {
  id: string;
  workspaceRoot: string;
  repos: IsolationRepo[];
  /**
   * Workspace paths outside every isolated repo, linked live into each task
   * workspace: loose entries of the workspace root, the entries beside a deeper
   * repo, and `sharedRepos`. For a lone repository, the repositories nested
   * inside it, which cannot be isolated with it and so are linked live instead.
   * Empty when a group of one holds no nested repositories.
   */
  shared: string[];
  /** Repos of the group that could not be isolated — no commits, or git refused a worktree — and are among `shared`. */
  sharedRepos: string[];
  /** Keyed by task id — ids are unique within one plan and a run belongs to one plan. */
  tasks: Record<string, IsolationTaskRecord>;
  /**
   * Set before a task's first merge and cleared once it has landed or been
   * rolled back. One found set — after a crash, or a rollback git refused —
   * names exactly what to return each repo's integration branch to.
   */
  landing?: IsolationLanding;
}

/**
 * What a plan persists of isolated execution (`LegacyPlanState.isolation`): its
 * run, and which added tasks resolve which conflicts. Belongs to that plan and
 * its branches alone, so a copy of the plan (a fork) must not carry it.
 */
export interface PlanIsolation {
  run: IsolationRun;
  /** Resolver task id → the conflicted task whose branch it merges. */
  resolvers: Record<string, string>;
}

/**
 * A task's isolation as a surface shows it. `kept` covers every record whose
 * worktree stays for inspection — a failed verdict, an interrupted attempt, an
 * integration git refused — because to the user they are one thing: work that
 * did not land and can be looked at. `none` is a task with no worktree in a plan
 * that has an isolation run.
 */
export type TaskIsolationState = 'none' | 'active' | 'integrated' | 'conflict' | 'repairing' | 'kept';

export type TaskIsolation =
  | { state: 'none' }
  | {
    state: Exclude<TaskIsolationState, 'none'>;
    branch: string;
    /** The task workspace; for a group of one, the task's worktree. */
    worktree: string;
    /** Paths of the repos the task changed. */
    repos: string[];
    conflictRepo?: string;
    /** Repo-relative paths, in `conflictRepo`, that conflicted. */
    conflictFiles?: string[];
    /** The conflict repair running or last run, of the most a task may have; absent before its first. */
    repair?: { attempt: number; limit: number };
    /** What {@link IsolationTaskRecord.repairedFiles} says. */
    repairedFiles?: string[];
  };

export interface IsolationLandedTask {
  taskId: string;
  order: number;
  title: string;
  /** Set when the task landed only after a conflict repair (ADR-0015): the files it was started for. */
  repairedFiles?: string[];
}

export interface IsolationHandoffRepo {
  path: string;
  integrationBranch: string;
  baseRef: string;
  /** Tasks whose work landed in this repo, in plan order. */
  landed: IsolationLandedTask[];
}

export interface IsolationHandoff {
  repos: IsolationHandoffRepo[];
  /** Tasks that landed on the integration branches, in plan order. */
  landed: IsolationLandedTask[];
}

/** A plan's isolation as a surface shows it: a mark for each task the run touched, and its handoff. */
export interface IsolationView {
  tasks: Record<string, TaskIsolation>;
  handoff: IsolationHandoff;
}

/**
 * Why "Merge all" would not touch a repo. `partial-landing`: a task's landing
 * was interrupted and could not be rolled back there, so its integration
 * branch holds part of a task.
 */
export type IsolationMergeBlockReason = 'merge-in-progress' | 'conflict' | 'uncommitted-changes' | 'partial-landing' | 'git-error';

export interface IsolationMergeBlock {
  repo: string;
  reason: IsolationMergeBlockReason;
  /** The files that would conflict, or the user's uncommitted ones the merge also changes; empty for the other reasons. */
  files: string[];
}

/**
 * How "Merge all" went.
 * - `merged`: every repo with work on its integration branch took it.
 * - `blocked`: the preflight found repos that could not, so nothing was
 *   touched anywhere; `blocked` says which and why.
 * - `conflict` / `failed`: a merge stopped in `repo` — on git older than 2.38,
 *   which cannot preflight, or for a reason no preflight could foresee. That
 *   merge was aborted, leaving `repo` as it was; `landed` names the repos
 *   merged before it, which stay merged, and is absent when there are none.
 *
 * A group of one is blocked only by a partial landing; otherwise its one merge
 * lands or is aborted whole, so it reports as it always has.
 */
export type IsolationMergeResult =
  | { outcome: 'merged' }
  | { outcome: 'blocked'; blocked: IsolationMergeBlock[] }
  | { outcome: 'conflict' | 'failed'; repo: string; files?: string[]; landed?: string[] };

/**
 * What `discard` does with each repo's integration branch: `keep` it for review
 * or merge, `delete` it, or delete it only in the repos whose checked-out HEAD
 * already contains it (`delete-merged`) — the one way that can never give up
 * landed work the user has not merged.
 */
export type IntegrationDisposal = 'keep' | 'delete' | 'delete-merged';

/**
 * Whether a conflict repair's work may land. `not-merged`: the task branch in
 * `repo` does not contain the tip the repair started from. `conflict-markers`:
 * it adds leftover conflict markers to `files`. `failed`: git could not tell.
 */
export type RepairEvidence =
  | { ok: true }
  | { ok: false; reason: 'not-merged' | 'conflict-markers' | 'failed'; repo: string; files?: string[] };

export interface PreparedTask {
  cwd: string;
  branch: string;
  /**
   * Paths, relative to the task workspace, that are copies rather than links
   * because a hard link was impossible (Windows, another volume). Edits to them
   * stay in the task, so the user is told.
   */
  copied: string[];
  /** What the attempt this one replaces left unlanded, kept on a branch before its worktree went; absent when nothing was. */
  preserved?: PreservedWork[];
}

/** A task as a removal names it. */
export type IsolationTaskRef = Pick<IsolationTaskRecord, 'taskId' | 'order' | 'title'>;

/**
 * Work a removal found that had not landed — edits never committed, or
 * commits only the task's branch carried — committed and kept on `branch`,
 * a branch of its own under `ordewell-preserved/`, before the worktree went.
 */
export interface PreservedWork {
  /** Absent for a leftover directory no task record owned. */
  task?: IsolationTaskRef;
  repo: string;
  branch: string;
  /** The commit `branch` points at. */
  commit: string;
}

/** A worktree a removal left in place, because the work in it could not be kept any other way. */
export interface RefusedRemoval {
  /** Absent for a leftover directory no task record owned. */
  task?: IsolationTaskRef;
  worktree: string;
  /** What stopped git keeping it, in words a surface can repeat. */
  reason: string;
}

/**
 * What removing task worktrees did in place of deleting work. A removal never
 * deletes work that has not landed: it keeps it on a branch first
 * (`preserved`), and where it cannot, it leaves that worktree alone
 * (`refused`) — so the record of a refused task stays too.
 */
export interface IsolationRemoval {
  preserved: PreservedWork[];
  refused: RefusedRemoval[];
}

/**
 * What a crash-recovery prune found and left alone: task records that were
 * `active` yet still held unlanded work, so the prune kept them as `kept`
 * rather than deleting work no one else has.
 */
export interface IsolationPruneResult extends IsolationRemoval {
  kept: IsolationTaskRef[];
}

/**
 * The tracked changes of a workspace's repos at one moment, against each
 * repo's HEAD: repo path → file path → the content it held then. What an ops
 * task's tree check compares against (ADR-0020).
 */
export type TreeSnapshot = Record<string, Record<string, string>>;

export interface IWorktreeIsolation {
  /**
   * A repo group with at least one repo to isolate, a clean tracked tree in
   * each, and the config enabled; otherwise the reason it is not.
   */
  isActive(workspaceRoot: string): Promise<IsolationAvailability>;

  /**
   * Put the tracked changes of every dirty repo of the group on its git stash,
   * the user's way out of a `dirty` refusal. Untracked files stay: they never
   * block isolation.
   */
  stash(workspaceRoot: string): Promise<void>;

  /**
   * Mint a run: resolve each repo's base ref to a commit now, and share the
   * repos that cannot be isolated. Only meaningful after `isActive` said yes;
   * throws when no repo of the group can be isolated after all.
   */
  startRun(workspaceRoot: string): Promise<IsolationRun>;

  /**
   * Create the task workspace — one worktree per isolated repo from its
   * integration tip, the shared paths linked in — and return the cwd to spawn
   * the Runner into. A second `prepare` for the same task is a retry: the old
   * attempt is discarded and the workspace recreated from the tips, so the
   * task sees everything its predecessors have integrated.
   */
  prepare(task: Task, run: IsolationRun): Promise<PreparedTask>;

  /**
   * Hand a conflicted task's kept workspace to a conflict repair (ADR-0015)
   * as it is — nothing is re-cut — and return the same cwd. Records each
   * changed repo's integration tip as `repairBase`, counts the repair, and
   * moves the task to `repairing`. Throws for a task that is not `conflict`.
   */
  reopen(task: Task, run: IsolationRun): Promise<PreparedTask>;

  /**
   * The evidence a repair must show before it lands: its work committed, and
   * in each repo of `repairBase` the task branch containing that tip
   * (`git merge-base --is-ancestor`) and adding no leftover conflict markers
   * (`git diff --check`; whitespace warnings do not count). Changes nothing
   * else: a task that fails stays `repairing` until released.
   */
  verifyRepair(task: Task, run: IsolationRun): Promise<RepairEvidence>;

  /**
   * Land the task atomically across the repos it changed: commit each
   * worktree, then `git merge --no-ff` the task branch into each changed
   * repo's integration branch. If any merge conflicts or fails, it is aborted
   * and the merges already made for the task are reset away, so `merged`
   * always means the whole task landed. Serialized inside the module; among
   * tasks waiting at once the lowest plan order goes first. On anything but
   * `merged` the worktrees and refs stay, and nothing is resolved here: a
   * conflict is repaired, if at all, by a new attempt of the task in its own
   * worktree (ADR-0015), never inside this queue.
   *
   * `persist` is called once `run.landing` is set and before the first
   * merge; the caller saves the run there, synchronously, which is what
   * lets `pruneOrphans` finish a landing a crash interrupted.
   */
  integrate(task: Task, run: IsolationRun, persist?: () => void): Promise<IsolationOutcome>;

  /**
   * `keep: false` removes the task's worktree, branch and record (retry, task
   * removal), keeping whatever had not landed on a branch first; a record
   * whose work cannot be kept stays, off `active`. `keep: true` leaves the
   * worktree and branch exactly as they are
   * for inspection — a failed verdict, a stop, a cancel — and only moves the task off `active`,
   * so a crash-recovery prune does not sweep it away; a repair it ends leaves
   * the task `conflict`, as it was before the repair. Takes the run rather than
   * a bare task id: ids are only unique within one plan, and one daemon serves
   * many (ADR-0007).
   */
  release(run: IsolationRun, taskId: string, opts: { keep: boolean }): Promise<IsolationRemoval>;

  /** End of run: park the integration branch for review and report what landed. */
  handoff(run: IsolationRun): Promise<IsolationHandoff>;

  /**
   * Drop what a crash left behind: a landing it interrupted is rolled back in
   * every repo, a repair it interrupted leaves its task `conflict`, then stale
   * active worktrees and directories no record owns go. An `active` record
   * that still holds unlanded work — commits its branch alone carries, or
   * edits in its worktree — is not a crash orphan: it may belong to a runner
   * another host is still driving, so it is kept as `kept` and named in the
   * result. A leftover directory holding work is kept on a branch before it
   * goes, as {@link release} does.
   */
  pruneOrphans(run: IsolationRun): Promise<IsolationPruneResult>;

  /** Unified diff of each repo's integration branch against its base ref. */
  reviewDiff(run: IsolationRun): Promise<string>;

  /**
   * Mark the landed tasks whose work the checked-out HEAD now contains in
   * every repo they changed (`git merge-base --is-ancestor`), and return their
   * ids. Only adds marks: a task found merged stays merged.
   */
  findInHead(run: IsolationRun): Promise<string[]>;

  /**
   * The tracked changes of each committed repo of the workspace's group,
   * except those in `exclude`; null when there is no repo to snapshot.
   * Untracked and ignored files never count.
   */
  snapshotTree(workspaceRoot: string, exclude: readonly string[]): Promise<TreeSnapshot | null>;

  /**
   * Tracked files whose content differs from what `snapshot` recorded: new
   * changes, and further changes to files already changed then. Paths are
   * from the workspace root. A repo git cannot read now is left out.
   */
  changedSince(workspaceRoot: string, snapshot: TreeSnapshot): Promise<string[]>;

  /**
   * "Merge all": merge each repo's integration branch into whatever the user
   * has checked out there. The one irreversible step, so it only ever happens
   * when a caller asks for it. Every repo with work is preflighted first — no
   * merge of the user's in progress, no conflict against their HEAD, no
   * uncommitted edit to a file the merge changes — and unless all pass,
   * nothing is merged anywhere. Only a merge Ordewell itself just started is
   * ever aborted; nothing of the user's is reset. Waits for a landing in
   * flight and holds the next back, so a merge during a run takes the
   * integration branches between two landings, never part of one.
   */
  mergeIntoCheckedOut(run: IsolationRun): Promise<IsolationMergeResult>;

  /**
   * Remove every worktree and task branch of the run, and settle each repo's
   * integration branch as `integration` says. Anything but `keep` also clears
   * the run's task records, except those of worktrees it refused to remove.
   * Work that had not landed is kept on a branch first, as {@link release} does.
   */
  discard(run: IsolationRun, opts: { integration: IntegrationDisposal }): Promise<IsolationRemoval>;

  /**
   * Clear what other runs left in each repo of `run`'s group: every
   * `ordewell/<run-id>/…` branch the repo's checked-out HEAD already contains.
   * Never a branch of `run` itself, one a worktree has checked out, or any
   * branch of a run that still has a worktree — that run may be live in
   * another plan. Tries every repo, then throws naming those where git failed.
   */
  sweep(run: IsolationRun): Promise<void>;
}
