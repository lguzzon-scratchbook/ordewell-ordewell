import type { IConfig } from './interfaces/IConfig';
import type { IFileSystem, ToolOutcome } from './interfaces/IFileSystem';
import type { ITerminalSession, QueuedTaskMessage, StructuredEvent, StructuredSessionCapability, StructuredTurnEnd } from './interfaces/ITerminalRunner';
import type { ApprovalDecision } from './interfaces/IApproval';
import type { TaskCompleteArgs } from './services/mcp/tools';
import type {
  IsolationAvailability,
  IsolationHandoff,
  IsolationMergeResult,
  IsolationOutcome,
  IsolationPruneResult,
  IsolationRun,
  IntegrationDisposal,
  PreparedTask,
  IWorktreeIsolation,
  RepairEvidence,
  TreeSnapshot,
} from './interfaces/IWorktreeIsolation';
import type { Task } from './models/Task';
import { handoffOf, integrationBranchFor, SELF_REPO } from './services/isolationRecord';

/**
 * Let an already-queued promise chain run to its next await before asserting,
 * without a wall-clock sleep. For a chain whose length is not known, drain the
 * microtask queue repeatedly. Only helps a chain that does not wait on a timer.
 */
export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

export function fakeConfig(overrides: Partial<IConfig> = {}): IConfig {
  return {
    aiProvider: 'openrouter',
    apiKey: 'sk-test',
    planningModel: 'test-model',
    enabledRunners: ['claude-code'],
    maxParallelSessions: 3,
    researchEnabled: false,
    researchMaxSteps: 10,
    researchMaxFileSize: 100_000,
    openAiBaseUrl: 'https://api.openai.com/v1',
    openAiApiKey: '',
    openrouterKey: '',
    geminiKey: '',
    openaiCompatibleBaseUrl: '',
    openaiCompatibleApiKey: '',
    orchestratorModel: '',
    researchSubagentModel: '',
    geminiModel: '',
    planMapEnabled: true,
    autonomousMode: true,
    // Off so an orchestrator built without an injected isolation never runs
    // real git against whatever repository the tests happen to run in.
    worktreeIsolation: false,
    workspaceRepos: [],
    worktreeLinks: [],
    // Off so a scripted conflict stays a conflict unless a test opts into repairing it.
    conflictRepairAttempts: 0,
    approvalMode: 'ask',
    approvalPreApproved: [],
    setProviderModelLists: () => {},
    getProviderBaseUrl: () => '',
    getProviderApiKey: () => '',
    ...overrides,
  };
}

const EMPTY_OUTCOME: ToolOutcome = { success: false, output: '', truncated: false };

/**
 * A complete {@link IFileSystem} stub. Lives here rather than in each package's
 * test folder so adding a tool to the interface is one edit, not one per suite.
 */
export function fakeFileSystem(overrides: Partial<IFileSystem> = {}): IFileSystem {
  return {
    readFile: async () => EMPTY_OUTCOME,
    readFiles: async () => EMPTY_OUTCOME,
    glob: async () => EMPTY_OUTCOME,
    grep: async () => EMPTY_OUTCOME,
    findSymbol: async () => EMPTY_OUTCOME,
    listDir: async () => EMPTY_OUTCOME,
    bash: async () => EMPTY_OUTCOME,
    getWorkspaceRoot: () => '/workspace',
    ...overrides,
  };
}

export class FakeTerminalSession implements ITerminalSession {
  private outputCbs: Array<(text: string) => void> = [];
  private exitCbs: Array<(code: number) => void> = [];
  output = '';
  written: string[] = [];
  killed = false;

  constructor(public id = 's1', public taskId = 't1') {}

  onOutput(cb: (text: string) => void): void { this.outputCbs.push(cb); }
  onExit(cb: (code: number) => void): void { this.exitCbs.push(cb); }
  kill(): void { this.killed = true; }
  getOutput(): string { return this.output; }
  write(text: string): void { this.written.push(text); }

  emitOutput(text: string): void {
    this.output += text;
    for (const cb of this.outputCbs) cb(text);
  }
  emitExit(code: number): void {
    for (const cb of this.exitCbs) cb(code);
  }
}

/**
 * A {@link FakeTerminalSession} that is feature-detected as structured
 * (ADR-0018): the turn, queue and native-session calls a test drives, with
 * no protocol behind them. It queues and delivers as `StructuredSession`
 * does — a message to an idle session starts a turn at once, one sent
 * mid-turn goes out as that turn ends, without passing through idle.
 */
export class FakeStructuredSession extends FakeTerminalSession implements StructuredSessionCapability {
  readonly transport = 'structured' as const;
  state: 'working' | 'idle' = 'working';
  messages: QueuedTaskMessage[] = [];
  /** Every message a turn was started with, in order. */
  delivered: string[] = [];
  interrupts = 0;
  private messageCount = 0;
  private turnEndCbs: Array<(reason: StructuredTurnEnd) => void> = [];
  private eventCbs: Array<(event: StructuredEvent) => void> = [];
  private completeCbs: Array<(report: TaskCompleteArgs) => void> = [];

  constructor(id = 's1', taskId = 't1', public sessionId: string | null = 'native-1') {
    super(id, taskId);
  }

  override write(text: string): void {
    super.write(text);
    const message = text.trim();
    if (message) this.sendMessage(message);
  }

  turnState(): 'working' | 'idle' { return this.state; }
  onTurnEnd(cb: (reason: StructuredTurnEnd) => void): void { this.turnEndCbs.push(cb); }
  onEvent(cb: (event: StructuredEvent) => void): void { this.eventCbs.push(cb); }
  onTaskComplete(cb: (report: TaskCompleteArgs) => void): void { this.completeCbs.push(cb); }
  /** The runner calls `task_complete`, as `StructuredSession` relays it. */
  reportComplete(report: TaskCompleteArgs): void {
    for (const cb of this.completeCbs) cb(report);
  }
  sendMessage(text: string): string {
    this.messageCount += 1;
    const id = `msg-${this.messageCount}`;
    if (this.state === 'idle') this.deliver(text);
    else this.messages.push({ id, text });
    return id;
  }
  removeQueued(id: string): boolean {
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.id !== id);
    return this.messages.length < before;
  }
  queued(): QueuedTaskMessage[] { return this.messages.map((m) => ({ ...m })); }
  async interrupt(): Promise<void> {
    this.interrupts += 1;
    if (this.state === 'working') this.emitTurnEnd('interrupted');
  }
  nativeSessionId(): string | null { return this.sessionId; }

  /** Every answer this session was given, in order. */
  answers: Array<{ id: string; decision: ApprovalDecision }> = [];
  private readonly openPermissions = new Set<string>();

  /** The runner asks to use a tool, as `StructuredSession` announces it. */
  requestPermission(id: string, name: string, input: Record<string, unknown>, suggestions: unknown[] = []): void {
    this.openPermissions.add(id);
    this.emitEvent({ type: 'permission_request', id, name, detail: JSON.stringify(input), input, suggestions });
  }
  /** The runner gives up on a request, as an interrupt makes it. */
  withdrawPermission(id: string): void {
    if (this.openPermissions.delete(id)) this.emitEvent({ type: 'permission_withdrawn', id });
  }
  answerPermission(id: string, decision: ApprovalDecision): boolean {
    if (!this.openPermissions.delete(id)) return false;
    this.answers.push({ id, decision });
    this.emitEvent({ type: 'permission_decided', id, decision });
    return true;
  }

  emitEvent(event: StructuredEvent): void {
    for (const cb of this.eventCbs) cb(event);
  }
  emitTurnEnd(reason: StructuredTurnEnd): void {
    const next = this.messages.shift();
    if (!next) this.state = 'idle';
    for (const cb of this.turnEndCbs) cb(reason);
    if (next) this.deliver(next.text);
  }

  private deliver(text: string): void {
    this.state = 'working';
    this.delivered.push(text);
    this.emitEvent({ type: 'turn_start', text });
  }
}

export type FakeIsolationCall =
  | { op: 'isActive'; workspaceRoot: string }
  | { op: 'stash'; workspaceRoot: string }
  | { op: 'startRun'; workspaceRoot: string }
  | { op: 'prepare' | 'reopen' | 'verifyRepair'; taskId: string }
  | { op: 'integrate'; taskId: string }
  | { op: 'release'; taskId: string; keep: boolean }
  | { op: 'handoff' | 'pruneOrphans' | 'reviewDiff' | 'mergeIntoCheckedOut' | 'sweep' | 'findInHead' | 'snapshotTree' | 'changedSince' }
  | { op: 'discard'; integration: IntegrationDisposal };

/**
 * An in-memory {@link IWorktreeIsolation} for scheduling tests: no git, no
 * filesystem. Every call is logged in `calls`; `prepare` hands back a
 * deterministic fake cwd. Set `availability` to exercise the fallbacks, `outcomes`
 * to script a conflict, and `holdIntegration` to keep a task un-integrated so a
 * test can observe that its dependents wait. `repos` makes the run a group of
 * several; `changes` and `stopsIn` say which of them a task changes and where
 * its landing stops. `repairEvidence` scripts what a conflict repair's
 * evidence check finds.
 */
export class FakeWorktreeIsolation implements IWorktreeIsolation {
  availability: IsolationAvailability = { active: true };
  /** The repo paths `startRun` groups: a group of one at `.` unless set. */
  repos: string[] = [SELF_REPO];
  /** Per task id, the repos it changes; every repo of the group when not listed. */
  changes = new Map<string, string[]>();
  /** Per task id, the repo its landing stops in when its outcome is not `merged`; its first changed repo when not listed. */
  stopsIn = new Map<string, string>();
  /** Per task id, the files a `conflict` outcome names; empty when not listed. */
  conflictFiles = new Map<string, string[]>();
  /** What `mergeIntoCheckedOut` answers; a `merged` one also puts every landed task in HEAD, as git would. */
  mergeResult: IsolationMergeResult = { outcome: 'merged' };
  /** Task ids whose landed work `findInHead` finds in HEAD besides those a merge put there, as a merge by hand would. */
  mergedByHand = new Set<string>();
  /** What `snapshotTree` answers; null as for a workspace with no repo. */
  treeSnapshot: TreeSnapshot | null = {};
  /** What `changedSince` answers: the tracked files an ops task changed. */
  changedFiles: string[] = [];
  /** What `startRun` shares and `prepare` copies, to exercise their notices. */
  shared: string[] = [];
  sharedRepos: string[] = [];
  copied: string[] = [];
  /** Set to make `startRun` throw, as git does when no repo of the group can be isolated. */
  startRunError: Error | null = null;
  /** Set to make `discard` / `sweep` throw after logging the call. */
  discardError: Error | null = null;
  sweepError: Error | null = null;
  /** What `pruneOrphans` reports as kept back from the sweep. */
  keptOnPrune: IsolationPruneResult['kept'] = [];
  /** Per task id; a task not listed integrates as `merged`. */
  outcomes = new Map<string, IsolationOutcome>();
  /** Per task id, what `verifyRepair` finds; a task not listed passes. */
  repairEvidence = new Map<string, RepairEvidence>();
  calls: FakeIsolationCall[] = [];
  private holds = new Map<string, Promise<void>>();
  private runCount = 0;

  private log(call: FakeIsolationCall): void { this.calls.push(call); }

  /** Task ids in the order `op` was called for them. */
  taskIdsFor(op: 'prepare' | 'reopen' | 'verifyRepair' | 'integrate' | 'release'): string[] {
    return this.calls.flatMap((c) => (c.op === op && 'taskId' in c ? [c.taskId] : []));
  }

  /** Make `integrate` for this task wait until the returned function is called. */
  holdIntegration(taskId: string): () => void {
    let open!: () => void;
    this.holds.set(taskId, new Promise<void>((resolve) => { open = resolve; }));
    return open;
  }

  async isActive(workspaceRoot: string): Promise<IsolationAvailability> {
    this.log({ op: 'isActive', workspaceRoot });
    return this.availability;
  }

  /** Like git: once the tracked changes are stashed, the tree is no longer dirty. */
  async stash(workspaceRoot: string): Promise<void> {
    this.log({ op: 'stash', workspaceRoot });
    if (!this.availability.active && this.availability.reason === 'dirty') this.availability = { active: true };
  }

  async startRun(workspaceRoot: string): Promise<IsolationRun> {
    this.log({ op: 'startRun', workspaceRoot });
    if (this.startRunError) throw this.startRunError;
    const id = `run${++this.runCount}`;
    return {
      id,
      workspaceRoot,
      repos: this.repos.map((repo) => ({
        path: repo, root: `${workspaceRoot}/${repo}`.replace(/\/\.$/, ''), baseRef: 'base0000', baseBranch: 'main', integrationBranch: integrationBranchFor(id),
      })),
      shared: [...this.shared],
      sharedRepos: [...this.sharedRepos],
      tasks: {},
    };
  }

  async prepare(task: Task, run: IsolationRun): Promise<PreparedTask> {
    this.log({ op: 'prepare', taskId: task.id });
    const name = `${task.order}-${task.id}`;
    const cwd = `/fake-worktrees/${run.id}/${name}`;
    const branch = `ordewell/${run.id}/${name}`;
    run.tasks[task.id] = {
      taskId: task.id, order: task.order, title: task.title, branch, workspace: cwd, status: 'active',
      repos: Object.fromEntries(run.repos.map((r) => [r.path, { worktree: r.path === SELF_REPO ? cwd : `${cwd}/${r.path}`, linked: [] }])),
    };
    return { cwd, branch, copied: [...this.copied] };
  }

  /** Like git: the same cwd, each changed repo's tip recorded, the repair counted. */
  async reopen(task: Task, run: IsolationRun): Promise<PreparedTask> {
    this.log({ op: 'reopen', taskId: task.id });
    const record = run.tasks[task.id];
    if (record?.status !== 'conflict') throw new Error(`Task ${task.order} has no conflict to repair`);
    const changed = Object.entries(record.repos).filter(([repo, entry]) => entry.changed || repo === record.conflictRepo).map(([repo]) => repo);
    const files = (record.conflictFiles ?? []).map((file) => (record.conflictRepo && record.conflictRepo !== SELF_REPO ? `${record.conflictRepo}/${file}` : file));
    record.repairs = (record.repairs ?? 0) + 1;
    record.repairBase = Object.fromEntries(changed.map((repo) => [repo, `tip-${repo}`]));
    record.repairedFiles = [...new Set([...(record.repairedFiles ?? []), ...files])];
    record.status = 'repairing';
    return { cwd: record.workspace, branch: record.branch, copied: [] };
  }

  async verifyRepair(task: Task, _run: IsolationRun): Promise<RepairEvidence> {
    this.log({ op: 'verifyRepair', taskId: task.id });
    return this.repairEvidence.get(task.id) ?? { ok: true };
  }

  /** Like git: the landing is recorded and persisted before the (held) merge, and cleared once it settles. */
  async integrate(task: Task, run: IsolationRun, persist: () => void = () => undefined): Promise<IsolationOutcome> {
    this.log({ op: 'integrate', taskId: task.id });
    const record = run.tasks[task.id];
    if (!record) return 'failed';
    const changed = this.changes.get(task.id) ?? run.repos.map((r) => r.path);
    for (const [repo, entry] of Object.entries(record.repos)) entry.changed = changed.includes(repo) || (entry.changed ?? false);
    if (changed.length > 0) {
      run.landing = { taskId: task.id, tips: Object.fromEntries(changed.map((repo) => [repo, `tip-${repo}`])) };
      persist();
    }
    await this.holds.get(task.id);
    delete run.landing;
    const outcome = this.outcomes.get(task.id) ?? 'merged';
    record.status = outcome;
    delete record.repairBase;
    if (outcome === 'merged') {
      delete record.conflictRepo;
      delete record.conflictFiles;
    } else {
      record.conflictRepo = this.stopsIn.get(task.id) ?? changed[0] ?? SELF_REPO;
      const files = this.conflictFiles.get(task.id);
      if (files) record.conflictFiles = files;
      else delete record.conflictFiles;
    }
    return outcome;
  }

  async release(run: IsolationRun, taskId: string, opts: { keep: boolean }): Promise<void> {
    this.log({ op: 'release', taskId, keep: opts.keep });
    const record = run.tasks[taskId];
    if (!opts.keep) delete run.tasks[taskId];
    else if (record?.status === 'active') record.status = 'kept';
    else if (record?.status === 'repairing') {
      record.status = 'conflict';
      delete record.repairBase;
    }
  }

  async handoff(run: IsolationRun): Promise<IsolationHandoff> {
    this.log({ op: 'handoff' });
    return handoffOf(run);
  }

  async pruneOrphans(): Promise<IsolationPruneResult> {
    this.log({ op: 'pruneOrphans' });
    return { kept: [...this.keptOnPrune] };
  }
  async reviewDiff(): Promise<string> { this.log({ op: 'reviewDiff' }); return ''; }
  async mergeIntoCheckedOut(run: IsolationRun): Promise<IsolationMergeResult> {
    this.log({ op: 'mergeIntoCheckedOut' });
    if (this.mergeResult.outcome === 'merged') {
      for (const record of Object.values(run.tasks)) if (record.status === 'merged') this.mergedByHand.add(record.taskId);
    }
    return this.mergeResult;
  }
  async findInHead(run: IsolationRun): Promise<string[]> {
    this.log({ op: 'findInHead' });
    const found: string[] = [];
    for (const record of Object.values(run.tasks)) {
      if (record.status !== 'merged' || record.inHead || !this.mergedByHand.has(record.taskId)) continue;
      record.inHead = true;
      found.push(record.taskId);
    }
    return found;
  }
  async snapshotTree(): Promise<TreeSnapshot | null> { this.log({ op: 'snapshotTree' }); return this.treeSnapshot; }
  async changedSince(): Promise<string[]> { this.log({ op: 'changedSince' }); return [...this.changedFiles]; }
  async discard(_run: IsolationRun, opts: { integration: IntegrationDisposal }): Promise<void> {
    this.log({ op: 'discard', integration: opts.integration });
    if (this.discardError) throw this.discardError;
  }
  async sweep(): Promise<void> {
    this.log({ op: 'sweep' });
    if (this.sweepError) throw this.sweepError;
  }
}
