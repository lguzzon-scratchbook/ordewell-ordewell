import { EventEmitter } from 'events';
import { spawn as nodeSpawn } from 'child_process';
import type {
  ITerminalSession,
  QueuedTaskMessage,
  StructuredEvent,
  StructuredSessionCapability,
  StructuredTurnEnd,
} from '../interfaces/ITerminalRunner';
import type { ApprovalDecision } from '../interfaces/IApproval';
import { checkpointReply, type CheckpointAnswer, type TaskCompleteArgs } from './mcp/tools';
import { sharedMcpServer, type OrdewellMcpServer, type TaskTokenScope } from './mcp/OrdewellMcpServer';
import { mcpClientConfig } from './mcp/clientConfig';
import type { ResearchToolType } from '../models/Task';
import { resolveTaskRunnerFlags } from '../plugins/resolveArgs';
import { AbstractRunner, AbstractTerminalSession, type RunnerSpawnOptions } from './AbstractRunner';
import type { AgentEvent, AgentProcessDeps, TaskModeAgentAdapter, TaskStartOptions } from './harness/AgentAdapter';
import { mapAgentTool, normalizeAgentArgs } from './harness/agentTools';
import { createTaskAdapter, takesOrdewellTools } from './harness/taskAdapters';

/** How long a soft interrupt may take before the runner is killed and resumed instead. */
const DEFAULT_INTERRUPT_GRACE_MS = 5000;
const TOOL_ARG_MAX_CHARS = 120;

export interface StructuredRunnerDeps {
  /** The OS boundary the adapters spawn through. `workspaceEnv` is always the spawn's own `env`. */
  process?: Partial<Omit<AgentProcessDeps, 'workspaceEnv'>>;
  /** Overrides adapter construction; production picks by runner id and refuses runners without a connector. */
  createAdapter?: (runner: string, deps: AgentProcessDeps) => TaskModeAgentAdapter;
  interruptGraceMs?: number;
  /** Serves the task tools of the runners that take them (ADR-0022). Defaults to the process's one server. */
  mcp?: OrdewellMcpServer;
}


/**
 * What the agent does only when it is working — the events that open a turn it
 * started itself. Anything else arriving between turns (a subagent's report, a
 * usage line) is the closed turn's tail and must not leave the task "working"
 * with nothing to end it.
 */
const TURN_OPENING_EVENTS = new Set<AgentEvent['type']>(['assistant_text', 'assistant_text_delta', 'thinking', 'thinking_delta', 'tool_call']);

/** The argument that says what a tool call is about: the command, the file, the pattern. */
const KEY_ARGS: Partial<Record<ResearchToolType, string>> = {
  bash: 'command',
  read_file: 'path',
  list_dir: 'path',
  grep: 'pattern',
  glob: 'pattern',
  fetch: 'url',
  web_search: 'query',
};
/** For tools with no Ordewell equivalent, the conventional fields in the order they tend to be most telling. */
const FALLBACK_KEY_ARGS = ['file_path', 'path', 'notebook_path', 'description', 'pattern', 'command', 'url', 'query', 'prompt'];

function toolLine(name: string, args: Record<string, unknown>): string {
  const { tool } = mapAgentTool(name);
  const normalized = normalizeAgentArgs(tool, args);
  const preferred = KEY_ARGS[tool];
  for (const key of preferred ? [preferred, ...FALLBACK_KEY_ARGS] : FALLBACK_KEY_ARGS) {
    const value = normalized[key];
    if (typeof value !== 'string') continue;
    const oneLine = value.replace(/\s+/g, ' ').trim();
    if (!oneLine) continue;
    const shown = oneLine.length > TOOL_ARG_MAX_CHARS ? `${oneLine.slice(0, TOOL_ARG_MAX_CHARS)}…` : oneLine;
    return `› ${name}(${shown})`;
  }
  return `› ${name}`;
}

/**
 * The plain-text channel (ADR-0018, O1a): what `VerdictEngine`, the planner's
 * live read and the fallback summary see. Deliberately lossy — no JSON, no
 * ANSI, subagents left out.
 *
 * Deltas are held back until a line completes or their block ends, so a
 * marker streamed as `<<<ORDE` + `WELL_DONE…` is written as one piece: a
 * reader scanning each chunk still sees it whole.
 */
class PlainTextChannel {
  private pending = '';
  /** What this text block has already written from its deltas. */
  private streamed = '';
  private atLineStart = true;

  constructor(private readonly write: (text: string) => void) {}

  delta(text: string): void {
    this.pending += text;
    const newline = this.pending.lastIndexOf('\n');
    if (newline < 0) return;
    const complete = this.pending.slice(0, newline + 1);
    this.pending = this.pending.slice(newline + 1);
    this.streamed += complete;
    this.out(complete);
  }

  /** A text block's authoritative copy, which supersedes its deltas. */
  block(text: string): void {
    const streamed = this.streamed;
    this.pending = '';
    this.streamed = '';
    // Anything else means the deltas and the block disagree; the block wins,
    // even at the cost of repeating text — evidence is never dropped.
    this.out(text.startsWith(streamed) ? text.slice(streamed.length) : text);
  }

  line(text: string): void {
    this.flush();
    if (!this.atLineStart) this.out('\n');
    this.out(`${text}\n`);
  }

  endTurn(): void {
    this.flush();
    this.streamed = '';
    if (!this.atLineStart) this.out('\n');
  }

  private flush(): void {
    if (!this.pending) return;
    this.streamed += this.pending;
    this.out(this.pending);
    this.pending = '';
  }

  private out(text: string): void {
    if (!text) return;
    this.atLineStart = text.endsWith('\n');
    this.write(text);
  }
}

interface OpenTurn {
  id: number;
  abort: AbortController;
  ended: boolean;
  reason: StructuredTurnEnd;
}

interface SessionLaunch {
  runner: string;
  deps: AgentProcessDeps;
  createAdapter: (runner: string, deps: AgentProcessDeps) => TaskModeAgentAdapter;
  startOptions: TaskStartOptions;
  interruptGraceMs: number;
  /** Where this attempt's task tools are served, when its runner takes them (ADR-0022). */
  tools?: { server: OrdewellMcpServer; scope: TaskTokenScope };
}

/**
 * One task driven over its runner's programmatic protocol (ADR-0018). It *is*
 * an `ITerminalSession`, so everything downstream of `onOutput` is unchanged;
 * what a terminal cannot do sits on {@link StructuredSessionCapability}.
 *
 * Ordewell owns the message queue (M1): a message sent mid-turn waits for the
 * turn to end rather than being typed into a runner that is busy.
 */
export class StructuredSession extends AbstractTerminalSession implements StructuredSessionCapability {
  readonly transport = 'structured' as const;

  private adapter: TaskModeAgentAdapter | null = null;
  private adapterStarted = false;
  /** Bumped whenever the adapter is replaced, so the old one's late events and exit are ignored. */
  private generation = 0;
  private output = '';
  private readonly text: PlainTextChannel;
  private state: 'working' | 'idle' = 'idle';
  private turn: OpenTurn | null = null;
  private turnCount = 0;
  private queue: QueuedTaskMessage[] = [];
  private messageCount = 0;
  private interrupting: Promise<void> | null = null;
  private lastSessionId: string | null = null;
  private readonly structuredEmitter = new EventEmitter();
  private permissionCount = 0;
  /**
   * Open tool requests by the id this session gave them, with the runner's own
   * id. The runner's ids are only unique to its process — Codex numbers its
   * requests — while an approval must be answerable by id across the session.
   */
  private readonly permissions = new Map<string, { requestId: string; adapter: TaskModeAgentAdapter }>();
  /** The launch's start options, with this attempt's server once its token is issued. */
  private startOptions: TaskStartOptions;
  /** This attempt's MCP token, until the session ends (ADR-0022, A2). */
  private toolToken: string | null = null;
  private checkpointHandler: ((question: string, signal: AbortSignal) => Promise<CheckpointAnswer>) | null = null;

  constructor(id: string, taskId: string, private readonly launch: SessionLaunch) {
    super(id, taskId);
    this.startOptions = launch.startOptions;
    this.text = new PlainTextChannel((text) => {
      this.output += text;
      this.outputEmitter.emit('output', text);
    });
  }

  /** Start the runner and send the task's prompt as its first turn. */
  async start(prompt: string): Promise<void> {
    await this.issueTools();
    try {
      await this.startAdapter(this.startOptions);
    } catch (err) {
      this.revokeTools();
      throw err;
    }
    // Callers attach their listeners once `spawn` resolves, so the first turn
    // waits for that or its opening events reach nobody. Working already, so
    // a message sent in the meantime queues behind the prompt.
    this.state = 'working';
    setImmediate(() => { if (!this.exited) this.deliver(prompt); });
  }

  getOutput(): string { return this.output; }

  onTaskComplete(listener: (report: TaskCompleteArgs) => void): void {
    this.structuredEmitter.on('taskComplete', listener);
  }

  onToolCheckpoint(handler: (question: string, signal: AbortSignal) => Promise<CheckpointAnswer>): void {
    this.checkpointHandler = handler;
  }

  /**
   * A server that cannot start costs the task its tools, not its run: the
   * prompt still teaches the marker (ADR-0022, S2).
   */
  private async issueTools(): Promise<void> {
    const tools = this.launch.tools;
    if (!tools) return;
    try {
      const credential = await tools.server.issueTaskToken(tools.scope, {
        taskComplete: async (report) => {
          this.structuredEmitter.emit('taskComplete', report);
          return { text: 'Recorded. End your turn now.' };
        },
        checkpoint: async ({ question }, { signal }) => {
          if (!this.checkpointHandler) return { text: 'checkpoint is not available in this session.', isError: true };
          return checkpointReply(await this.checkpointHandler(question, signal));
        },
      });
      if (this.exited) {
        tools.server.revoke(credential.token);
        return;
      }
      this.toolToken = credential.token;
      this.startOptions = { ...this.startOptions, mcp: mcpClientConfig(credential) };
    } catch (err) {
      console.error(`[structured] No Ordewell tools for task ${this.taskId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private revokeTools(): void {
    if (this.toolToken === null) return;
    this.launch.tools?.server.revoke(this.toolToken);
    this.toolToken = null;
  }

  protected override baseHandleExit(code: number): void {
    this.revokeTools();
    this.undeliverQueued();
    super.baseHandleExit(code);
  }

  /** A reply typed at the task — a checkpoint answer, most often — is a user message. */
  write(text: string): void {
    const message = text.trim();
    if (message) this.sendMessage(message);
  }

  kill(): void {
    if (this.exited) return;
    const adapter = this.adapter;
    this.generation += 1;
    this.turn?.abort.abort();
    // An adapter still starting has no process yet to kill; `startAdapter`
    // disposes it once it has one.
    if (adapter && this.adapterStarted) adapter.dispose();
    this.withdrawPermissions();
    this.baseHandleExit(-1);
  }

  turnState(): 'working' | 'idle' { return this.state; }

  onTurnEnd(listener: (reason: StructuredTurnEnd) => void): void {
    this.structuredEmitter.on('turnEnd', listener);
  }

  onEvent(listener: (event: StructuredEvent) => void): void {
    this.structuredEmitter.on('event', listener);
  }

  sendMessage(text: string): string {
    this.messageCount += 1;
    const id = `msg-${this.messageCount}`;
    if (this.exited) this.emitEvent({ type: 'message_undelivered', messageId: id, text });
    else if (this.state === 'idle' && this.adapterStarted) this.deliver(text);
    else {
      this.queue.push({ id, text });
      this.emitEvent({ type: 'message_queued', messageId: id, text });
    }
    return id;
  }

  removeQueued(id: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((m) => m.id !== id);
    if (this.queue.length === before) return false;
    this.emitEvent({ type: 'message_removed', messageId: id });
    return true;
  }

  queued(): QueuedTaskMessage[] { return this.queue.map((m) => ({ ...m })); }

  nativeSessionId(): string | null {
    return this.adapter?.nativeSessionId() ?? this.lastSessionId;
  }

  answerPermission(id: string, decision: ApprovalDecision): boolean {
    const open = this.permissions.get(id);
    if (!open) return false;
    this.permissions.delete(id);
    if (!open.adapter.answerPermission(open.requestId, decision)) {
      this.emitEvent({ type: 'permission_withdrawn', id });
      return false;
    }
    this.emitEvent({ type: 'permission_decided', id, decision });
    return true;
  }

  /** Every open request goes unanswered once the process that asked is gone. */
  private withdrawPermissions(adapter?: TaskModeAgentAdapter): void {
    for (const [id, open] of [...this.permissions]) {
      if (adapter && open.adapter !== adapter) continue;
      this.permissions.delete(id);
      this.emitEvent({ type: 'permission_withdrawn', id });
    }
  }

  interrupt(): Promise<void> {
    if (this.interrupting) return this.interrupting;
    const turn = this.turn;
    const adapter = this.adapter;
    if (!turn || turn.ended || !adapter) return Promise.resolve();
    this.interrupting = this.interruptTurn(turn, adapter).finally(() => { this.interrupting = null; });
    return this.interrupting;
  }

  private async interruptTurn(turn: OpenTurn, adapter: TaskModeAgentAdapter): Promise<void> {
    const grace = this.launch.interruptGraceMs;
    const ended = new Promise<void>((resolve) => this.structuredEmitter.once('turnEnd', () => resolve()));
    if (await adapter.interrupt(grace)) {
      // Acknowledged, but the turn only ends with its result line.
      const settled = await Promise.race([
        ended.then(() => true),
        new Promise<boolean>((resolve) => { const t = setTimeout(() => resolve(false), grace); t.unref?.(); }),
      ]);
      if (settled) return;
    }
    if (turn.ended || this.exited) return;
    await this.restartInterrupted(turn);
  }

  /**
   * The fallback when the runner ignores a soft interrupt: kill it and resume
   * its session in a fresh process, the way the planner restarts from its
   * session id after an abort.
   */
  private async restartInterrupted(turn: OpenTurn): Promise<void> {
    // A continue interrupted before its runner took the session up still
    // resumes that session, never a fresh one.
    const resumeSessionId = this.nativeSessionId() ?? this.startOptions.resumeSessionId;
    this.generation += 1;
    turn.abort.abort();
    if (this.adapter) this.withdrawPermissions(this.adapter);
    try {
      await this.startAdapter({ ...this.startOptions, resumeSessionId });
    } catch (err) {
      this.text.line(`Could not restart ${this.launch.runner} after the interrupt: ${err instanceof Error ? err.message : String(err)}`);
      this.withdrawPermissions();
      this.baseHandleExit(-1);
      this.endTurn(turn, 'interrupted');
      return;
    }
    this.endTurn(turn, 'interrupted');
  }

  private async startAdapter(opts: TaskStartOptions): Promise<void> {
    const adapter = this.launch.createAdapter(this.launch.runner, this.launch.deps);
    this.adapter = adapter;
    this.adapterStarted = false;
    const generation = this.generation;
    await adapter.start(opts);
    this.adapterStarted = true;
    if (this.exited || generation !== this.generation) {
      adapter.dispose();
      return;
    }
    adapter.onOutOfTurn?.((event) => this.handleOutOfTurn(adapter, generation, event));
    adapter.onProcessExit((code) => {
      if (generation !== this.generation) return;
      this.lastSessionId = adapter.nativeSessionId() ?? this.lastSessionId;
      this.withdrawPermissions();
      this.baseHandleExit(code);
    });
  }

  private openTurn(text: string, messageId?: string): OpenTurn {
    this.turnCount += 1;
    const turn: OpenTurn = { id: this.turnCount, abort: new AbortController(), ended: false, reason: 'completed' };
    this.turn = turn;
    this.state = 'working';
    this.emitEvent({ type: 'turn_start', text, ...(messageId ? { messageId } : {}) });
    return turn;
  }

  private deliver(text: string, messageId?: string): void {
    const adapter = this.adapter;
    if (!adapter) return;
    const turn = this.openTurn(text, messageId);
    const generation = this.generation;

    void adapter.send(text, (event) => {
      if (generation !== this.generation) return;
      this.route(adapter, turn, event);
    }, turn.abort.signal).catch((err: unknown) => {
      if (generation !== this.generation || this.exited) return;
      turn.reason = 'failed';
      this.handleEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }).then(() => {
      this.lastSessionId = adapter.nativeSessionId() ?? this.lastSessionId;
      if (generation === this.generation) this.endTurn(turn, turn.reason);
    });
  }

  private route(adapter: TaskModeAgentAdapter, turn: OpenTurn | null, event: AgentEvent): void {
    if (event.type === 'turn_end') {
      if (turn) turn.reason = event.interrupted ? 'interrupted' : 'completed';
    } else if (event.type === 'permission_request') this.openPermission(adapter, event);
    else if (event.type === 'permission_cancelled') this.cancelPermission(adapter, event.id);
    else {
      if (event.type === 'error' && turn) turn.reason = 'failed';
      this.handleEvent(event);
    }
  }

  /**
   * The runner spoke with no message of ours in flight. When it is working — a
   * turn it opened itself once background work finished — that is a turn of the
   * task like any other: the state says working, a queued message waits, and its
   * end settles it. A message with no text in `turn_start` marks it as not ours.
   */
  private handleOutOfTurn(adapter: TaskModeAgentAdapter, generation: number, event: AgentEvent): void {
    if (generation !== this.generation || this.exited) return;
    let turn = this.turn && !this.turn.ended ? this.turn : null;
    if (!turn && TURN_OPENING_EVENTS.has(event.type)) turn = this.openTurn('');
    this.route(adapter, turn, event);
    if (turn && (event.type === 'turn_end' || event.type === 'error')) this.endTurn(turn, turn.reason);
  }

  private openPermission(adapter: TaskModeAgentAdapter, event: Extract<AgentEvent, { type: 'permission_request' }>): void {
    this.permissionCount += 1;
    const id = `${this.id}-perm-${this.permissionCount}`;
    if (event.decided) {
      this.emitEvent({ ...event, id });
      this.emitEvent({ type: 'permission_decided', id, decision: event.decided });
      return;
    }
    this.permissions.set(id, { requestId: event.id, adapter });
    this.emitEvent({ ...event, id });
  }

  private cancelPermission(adapter: TaskModeAgentAdapter, requestId: string): void {
    for (const [id, open] of this.permissions) {
      if (open.adapter !== adapter || open.requestId !== requestId) continue;
      this.permissions.delete(id);
      this.emitEvent({ type: 'permission_withdrawn', id });
      return;
    }
  }

  private handleEvent(event: Exclude<AgentEvent, { type: 'turn_end' | 'permission_request' | 'permission_cancelled' }>): void {
    switch (event.type) {
      case 'assistant_text_delta': this.text.delta(event.text); break;
      case 'assistant_text': this.text.block(event.text); break;
      case 'tool_call': if (!event.subagentId) this.text.line(toolLine(event.name, event.args)); break;
      case 'error': this.text.line(event.message); break;
      default: break;
    }
    this.emitEvent(event);
  }

  /**
   * A queued message goes out as the turn closes, and the state never passes
   * through `idle` on the way, so a listener told the turn ended can already
   * see the task is not waiting.
   */
  private endTurn(turn: OpenTurn, reason: StructuredTurnEnd): void {
    if (turn.ended) return;
    turn.ended = true;
    this.text.endTurn();
    this.emitEvent({ type: 'turn_end', reason });
    if (reason === 'failed') this.undeliverQueued();
    this.state = !this.exited && this.queue.length ? 'working' : 'idle';
    this.structuredEmitter.emit('turnEnd', reason);
    const next = this.exited ? undefined : this.queue.shift();
    if (next) this.deliver(next.text, next.id);
  }

  private undeliverQueued(): void {
    const messages = this.queue;
    this.queue = [];
    for (const { id, text } of messages) this.emitEvent({ type: 'message_undelivered', messageId: id, text });
  }

  private emitEvent(event: StructuredEvent): void {
    this.structuredEmitter.emit('event', event);
  }
}

/**
 * The structured transport (ADR-0018): a task's runner as a plain child
 * process speaking its protocol — no tmux, no `script` (W2). Only runners
 * with a task-mode connector can be spawned here; routing the rest to the
 * terminal transport is the caller's decision, not a silent downgrade here.
 */
export class StructuredRunner extends AbstractRunner<StructuredSession> {
  private spawnCount = 0;
  private readonly processDeps: Partial<Omit<AgentProcessDeps, 'workspaceEnv'>>;
  private readonly createAdapter: (runner: string, deps: AgentProcessDeps) => TaskModeAgentAdapter;
  private readonly interruptGraceMs: number;
  private readonly mcp: OrdewellMcpServer;

  constructor(deps: StructuredRunnerDeps = {}) {
    super();
    this.processDeps = deps.process ?? {};
    this.createAdapter = deps.createAdapter ?? createTaskAdapter;
    this.interruptGraceMs = deps.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
    this.mcp = deps.mcp ?? sharedMcpServer();
  }

  async spawn(opts: RunnerSpawnOptions): Promise<ITerminalSession> {
    const manifest = opts.registry?.get(opts.runner)?.manifest;
    if (!manifest) throw new Error(`No runner manifest is registered for "${opts.runner}".`);

    this.spawnCount += 1;
    const id = `ordewell-structured-${opts.taskId.slice(0, 8)}-${this.spawnCount}`;
    const env = { ...opts.env };
    const session = new StructuredSession(id, opts.taskId, {
      runner: opts.runner,
      deps: {
        spawn: nodeSpawn,
        fetch: globalThis.fetch,
        ...this.processDeps,
        // Already resolved by the caller (ADR-0016); resolving it again here
        // could disagree with what a terminal task in the same run sees.
        workspaceEnv: async () => env,
      },
      createAdapter: this.createAdapter,
      startOptions: {
        kind: 'task',
        cwd: opts.cwd,
        model: opts.modelId,
        mode: opts.mode ?? 'default',
        flags: resolveTaskRunnerFlags(manifest, { mode: opts.mode ?? 'default', model: opts.modelId, thinkingEffort: opts.thinkingEffort }),
        resumeSessionId: opts.resumeSessionId,
      },
      interruptGraceMs: this.interruptGraceMs,
      ...(takesOrdewellTools(opts.runner)
        ? { tools: { server: this.mcp, scope: { sessionId: opts.planSessionId ?? '', taskId: opts.taskId, attempt: opts.attempt ?? 1 } } }
        : {}),
    });

    console.error(`[structured] Starting ${opts.runner} [${opts.mode ?? 'default'}] (${opts.modelId || 'default'}) for task ${opts.taskId.slice(0, 8)}`);
    this.registerSession(id, session);
    try {
      await session.start(opts.prompt);
    } catch (err) {
      this.sessions.delete(id);
      throw err;
    }
    return session;
  }
}
