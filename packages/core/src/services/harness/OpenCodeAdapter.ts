import type { ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { augmentedPath } from '../../utils/shellPath';
import { planDirectLaunch, isExecutableResolved, ExecutableNotFoundError } from '../../utils/launch';
import { assertWorkspaceExists } from '../../utils/workspace';
import { killTree } from '../../utils/processTree';
import { workspaceEnvOf } from '../workspaceEnv';
import { runnerEnv } from './runnerEnv';
import { OpenCodeV2 } from './OpenCodeV2';
import { partedPromptUsage, type UsageRecord } from '../../models/Usage';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions, PlannerStartOptions, TaskModeAgentAdapter, TaskStartOptions } from './AgentAdapter';

const SERVER_READY_TIMEOUT_MS = 30000;
const STDERR_TAIL_CHARS = 4000;
/** How long a turn waits for `/event` before posting anyway. See {@link OpenCodeAdapter.send}. */
const STREAM_CONNECT_TIMEOUT_MS = 5000;
/** See {@link OpenCodeAdapter.recoverReply}. */
const RECOVERY_POLL_INTERVAL_MS = 2000;
const RECOVERY_TIMEOUT_MS = 900000;
/** How often a task turn reads `/session/status` itself — see {@link OpenCodeAdapter.pollStatus}. */
const STATUS_POLL_INTERVAL_MS = 1000;
/** The Basic-auth username `serve` defaults to. Set explicitly so a host's own `OPENCODE_SERVER_USERNAME` cannot win. */
const SERVER_USERNAME = 'opencode';

/**
 * Tools withheld from a planning session (T1). `question` is the load-bearing
 * one: it blocks the turn on an answer from a user who is not watching, and the
 * message POST then never returns — an absent answer has to mean denial, not a
 * hung planner. The rest are the write tools, withheld for the same reason
 * {@link ClaudeCodeAdapter} names them despite `--permission-mode plan`: the
 * `plan` agent already refuses them, and a future default must not quietly
 * hand the planner an edit.
 */
const DISABLED_TOOLS: Record<string, boolean> = {
  question: false,
  edit: false,
  write: false,
  apply_patch: false,
  todowrite: false,
};

/**
 * A task asks its user in plain text for now: the `question` tool blocks the
 * turn on an answer no surface can give yet. Nothing else is withheld — the
 * task's agent decides what it may do.
 */
const TASK_DISABLED_TOOLS: Record<string, boolean> = { question: false };

/** The `approvals` mode setting that answers every request the way `opencode run --auto` does. */
const AUTO_APPROVALS = 'auto';

interface OpenCodePart {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  messageID?: string;
  /** Set on a text or reasoning part once it is complete. */
  time?: { start?: number; end?: number };
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    /** On a `task` call once its child session exists: that session's id and the model it runs. */
    metadata?: { sessionId?: string; model?: { providerID?: string; modelID?: string } };
  };
}

/** `permission.asked` (and its v2 spelling) — the only server→client request OpenCode makes. */
interface OpenCodePermissionAsk {
  id?: string;
  sessionID?: string;
  permission?: string;
  action?: string;
  patterns?: string[];
  resources?: string[];
  metadata?: Record<string, unknown>;
  /** The patterns an `always` reply grants for the rest of the server's life — the task's. */
  always?: string[];
  tool?: { messageID?: string; callID?: string };
}

/** OpenCode's errors are tagged unions: `{ name, data: { message } }`. */
interface OpenCodeError {
  name?: string;
  data?: { message?: string };
}

interface OpenCodeMessageInfo {
  id?: string;
  role?: string;
  time?: { created?: number; completed?: number };
  error?: OpenCodeError;
  providerID?: string;
  modelID?: string;
  /** USD, as OpenCode prices the call. */
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
}

/** One `/event` frame, narrowed to the fields this adapter reads. */
interface OpenCodeEvent {
  type?: string;
  properties?: OpenCodePermissionAsk & {
    part?: OpenCodePart;
    info?: OpenCodeMessageInfo & { parentID?: string };
    /** `message.part.delta`: an append to one field of a part already announced. */
    messageID?: string;
    partID?: string;
    field?: string;
    delta?: string;
    /** `session.status`. */
    status?: { type?: string };
    /** `session.error`. */
    error?: OpenCodeError;
    /** `permission.replied`: the request that is no longer open. */
    requestID?: string;
  };
}

/**
 * What one turn has learned from `/event` so far. The stream names a part's
 * message but never its role, and a delta names neither its part's type nor
 * whether it belongs to the reply — so each is remembered from the frame that
 * announced it.
 */
interface TurnState {
  seen: Set<string>;
  /** Assistant message ids, from `message.updated`. A part of any other message is the user's own words. */
  assistantMessages: Set<string>;
  partTypes: Map<string, string>;
  /** Reply text parts that have started streaming — see {@link OpenCodeAdapter.onTextDelta}. */
  textRuns: Map<string, { held: string; lead: string | null }>;
  /** Child sessions of the planner's, mapped to the `task` call that spawned each once its part names it. */
  children: Map<string, string | null>;
  /** Frames from a child session that arrived before its `task` call named it. */
  heldFrames: Map<string, OpenCodeEvent[]>;
}

/**
 * When one task turn is over. `prompt_async` returns before the work starts,
 * so the end is read from the session going idle — the way OpenCode's own
 * `run` reads it (see {@link OpenCodeAdapter.sendTask}).
 */
interface TaskTurn {
  /**
   * This turn's own work has been seen. Until then an idle is the previous
   * turn's, arriving late, and settles nothing — what upstream's per-turn
   * counter guards against.
   */
  live: boolean;
  /** The user messages the server echoed back: storing the prompt is not the model working on it. */
  userMessages: Set<string>;
  /** `session.error` for the task's session, in OpenCode's own words. */
  failure: string | null;
  /** The newest assistant message's own error, cleared by a later message that has none. */
  messageError: string | null;
  done: boolean;
  finish: () => void;
  /** Resolves when {@link finish} is called. */
  ended: Promise<void>;
}

interface OpenCodeMessageResponse {
  parts?: OpenCodePart[];
  info?: OpenCodeMessageInfo;
  error?: { message?: string } | string;
}

/**
 * OpenCode addresses a model as `{providerID, modelID}`; discovery and the
 * plan artifact carry the flat `provider/model` id the CLI's `--model` flag
 * takes. Split on the first slash — provider ids never contain one, model ids
 * sometimes do (`openrouter/anthropic/claude-sonnet-4`).
 */
function splitModelId(id: string): { providerID: string; modelID: string } | null {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return null;
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}

/**
 * Flatten an error and its `cause` chain into one line. Node's `fetch` reports
 * every transport failure as the same bare `TypeError: fetch failed`; which
 * failure it was (a socket reset, a refused connect, undici's 300s header
 * timeout) lives only in `cause`, so a message without it names nothing.
 */
function describeError(err: unknown): string {
  const visited = new Set<unknown>();
  const lines: string[] = [];
  let current: unknown = err;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (!(current instanceof Error)) { lines.push(String(current)); break; }
    const code = (current as { code?: unknown }).code;
    const suffix = typeof code === 'string' && !current.message.includes(code) ? ` (${code})` : '';
    lines.push(`${current.message}${suffix}`);
    current = current.cause;
  }
  return lines.join(': ');
}

function permissionName(ask: OpenCodePermissionAsk): string {
  return ask.permission ?? ask.action ?? 'permission';
}

function permissionDetail(ask: OpenCodePermissionAsk): string {
  const scope = (ask.patterns ?? ask.resources ?? []).join(', ');
  return JSON.stringify({ ...(scope ? { scope } : {}), ...(ask.metadata ?? {}) });
}

function errorText(error: OpenCodeError): string {
  return error.data?.message || error.name || 'OpenCode reported an error.';
}

function flatModelId(providerID: string | undefined, modelID: string | undefined): string | undefined {
  return providerID && modelID ? `${providerID}/${modelID}` : undefined;
}

/**
 * OpenCode's `input` counts only the uncached prompt — cache reads and writes
 * sit beside it, as with Anthropic ({@link partedPromptUsage}): in the
 * recordings `tokens.total` is input + output + both cache counts. Its `output`
 * excludes `reasoning` (a recorded reply with text reports output 0 beside
 * reasoning 127), and reasoning is billed as output, so it is counted as output.
 */
function usageRecord(info: OpenCodeMessageInfo, subagentId?: string): UsageRecord | null {
  const tokens = info.tokens;
  if (!tokens) return null;
  const prompt = partedPromptUsage({ uncached: tokens.input, cacheRead: tokens.cache?.read, cacheWrite: tokens.cache?.write });
  const outputTokens = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  // A call that failed before the provider answered reports all zeros. That
  // is no measurement, and a zero prompt would read as an empty context.
  if ((prompt.inputTokens ?? 0) + outputTokens === 0) return null;
  const record: UsageRecord = { source: 'opencode', ...prompt, outputTokens };
  const model = flatModelId(info.providerID, info.modelID);
  if (model) record.model = model;
  // OpenCode prices a call itself, from its model catalog, so a reported 0
  // means a free model or one the catalog has no price for. Those cannot be
  // told apart, so 0 is left unreported: a ledger may not claim a bill of
  // nothing.
  if (typeof info.cost === 'number' && info.cost > 0) record.reportedCost = { amount: info.cost, currency: 'USD' };
  if (subagentId) record.subagentId = subagentId;
  return record;
}

/** The subagent's report without the `<task>` envelope the tool wraps it in. */
function taskDigest(output: string): string {
  const inner = output.match(/<task_result>\n?([\s\S]*?)\n?<\/task_result>/);
  return inner ? inner[1] : output;
}

/**
 * `read`/`write`/`edit` results come back wrapped in a `<path>`/`<type>`/`<content>`
 * envelope instead of plain text (unlike `bash`'s stdout), so the row's `⎿`
 * preview would otherwise show those tags verbatim. A tool whose output has no
 * `<content>` tag — bash, glob, grep — is returned unchanged.
 */
function unwrapFileToolOutput(output: string): string {
  const inner = output.match(/<content>\n?([\s\S]*?)\n?<\/content>/);
  return inner ? inner[1] : output;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function newTurnState(): TurnState {
  return { seen: new Set(), assistantMessages: new Set(), partTypes: new Map(), textRuns: new Map(), children: new Map(), heldFrames: new Map() };
}

/** OpenCode's three answers to a permission request, from Ordewell's three (ADR-0018, A1). */
function permissionReply(decision: ApprovalDecision): { reply: 'once' | 'always' | 'reject'; message?: string } {
  if (decision.decision === 'allow') return { reply: 'once' };
  if (decision.decision === 'allowForTask') return { reply: 'always' };
  const note = decision.note?.trim();
  // With a message OpenCode hands the note to the agent as a correction; without one it is a bare refusal.
  return note ? { reply: 'reject', message: note } : { reply: 'reject' };
}

/**
 * OpenCode as a planner or a task runner, over its headless HTTP server
 * (ADR-0009, ADR-0018).
 *
 * The odd one out: `opencode serve` is a real server rather than a stdio
 * protocol, so this adapter owns both halves of the boundary — it spawns the
 * process through the same injected `spawn` every other adapter uses, then
 * talks to it through the injected `fetch`. Both are part of the one seam the
 * tests drive.
 *
 * A planner turn ends when the message POST resolves, and its response is the
 * authoritative copy of the reply's last message. Everything else — reply text
 * as it streams, earlier model calls' text and reasoning, per-call usage, the
 * subagents a `task` call runs — arrives only on the server's `/event` channel.
 * An event name that changes between OpenCode versions therefore costs that
 * detail, never the final reply. A task turn is posted asynchronously and read
 * entirely from the stream — see {@link sendTask}.
 */
export class OpenCodeAdapter implements TaskModeAgentAdapter {
  readonly agentId = 'opencode';

  private process: ChildProcess | null = null;
  private baseUrl: string | null = null;
  /** Sent on every request to a task's server, which a per-task password secures. */
  private authorization: string | null = null;
  private sessionId: string | null = null;
  private stderrTail = '';
  private exited = false;
  private exitCode = -1;
  private disposed = false;
  private markEnded: () => void = () => {};
  private readonly processEnded = new Promise<void>((resolve) => { this.markEnded = resolve; });
  private planner: PlannerStartOptions | null = null;
  private task: TaskStartOptions | null = null;
  /** Whether this turn has already emitted reply text — see {@link emitPart}. */
  private turnHasText = false;
  /** The last assistant message already settled — the baseline {@link recoverReply} measures a new reply against. */
  private lastAssistantId: string | null = null;
  private taskTurn: TaskTurn | null = null;
  /** An abort was posted during the current task turn, so the idle that follows ends it as interrupted. */
  private interruptRequested = false;
  /** A task's requests waiting for an answer, by request id, with the session that asked. */
  private readonly openPermissions = new Map<string, string>();
  /** Set once the server turns out to speak the 2.x API, which then owns the session. */
  private v2: OpenCodeV2 | null = null;

  constructor(private deps: AgentProcessDeps) {}

  async start(opts: AgentStartOptions): Promise<void> {
    if (opts.kind === 'task') this.task = opts;
    else this.planner = opts;
    // Checked before anything else: a workspace deleted out from under a
    // stale `process.cwd()` otherwise surfaces as `spawn`'s ENOENT, which
    // reads as a missing `opencode` binary rather than a missing directory.
    assertWorkspaceExists(opts.cwd, { isDirectory: this.deps.isDirectory });
    const resolvePath = this.deps.resolvePath ?? augmentedPath;
    const PATH = await resolvePath();

    // On POSIX this is `opencode` unchanged; on Windows it resolves the real
    // executable, because CreateProcess performs no PATHEXT lookup.
    const launch = await planDirectLaunch('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      platform: this.deps.platform,
      resolvePath,
    });
    if (!isExecutableResolved('opencode', launch, PATH, { platform: this.deps.platform, exists: this.deps.exists })) {
      throw new ExecutableNotFoundError('opencode', PATH);
    }
    const workspaceEnv = await (this.deps.workspaceEnv ?? workspaceEnvOf)(opts.cwd);
    // A task's server edits the worktree, and `serve` without a password
    // takes orders from any local process. The password exists only in this
    // adapter and the server's environment, after the workspace's own
    // variables so none of them can replace it. A planner's gets one too:
    // 2.x answers every `/api` request without credentials with a 401, so a
    // server with no password cannot be spoken to at all.
    const password = randomBytes(24).toString('base64url');
    this.process = this.deps.spawn(launch.file, launch.args, {
      env: runnerEnv(PATH, { ...workspaceEnv, OPENCODE_SERVER_USERNAME: SERVER_USERNAME, OPENCODE_SERVER_PASSWORD: password }),
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      windowsVerbatimArguments: launch.verbatim,
    });
    this.authorization = `Basic ${Buffer.from(`${SERVER_USERNAME}:${password}`).toString('base64')}`;
    // Nothing is written here today, but an EPIPE on an unheard pipe crashes
    // the host, and the exit path already reports a dead server.
    this.process.stdin?.on('error', () => {});

    const banner = new Promise<string | null>((resolve) => {
      let seen = '';
      const scan = (chunk: Buffer) => {
        seen += chunk.toString();
        const match = seen.match(/https?:\/\/[^\s]+/);
        if (match) resolve(match[0].replace(/[.,)]$/, ''));
      };
      const ended = (code: number) => {
        if (this.exited) return;
        this.exited = true;
        this.exitCode = code;
        this.markEnded();
        resolve(null);
      };
      this.process!.stdout?.on('data', scan);
      this.process!.stderr?.on('data', (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
        scan(chunk);
      });
      this.process!.on('exit', (code) => ended(code ?? -1));
      this.process!.on('error', (err) => {
        this.stderrTail = (this.stderrTail + `\n${err.message}`).slice(-STDERR_TAIL_CHARS);
        ended(-1);
      });
      const timer = setTimeout(() => resolve(null), SERVER_READY_TIMEOUT_MS);
      timer.unref?.();
    });

    this.baseUrl = await banner;
    if (!this.baseUrl) {
      throw new Error(`The OpenCode ${this.role()} server did not start.${this.stderrTail.trim() ? `\n\n${this.stderrTail.trim()}` : ''}`);
    }

    if (await this.speaksV2()) {
      this.v2 = new OpenCodeV2({
        request: (method, path, body, signal) => this.request(method, path, body, signal),
        json: (method, path, body, signal) => this.json(method, path, body, signal),
        openEvents: (signal) => this.deps.fetch(`${this.baseUrl}/api/event`, { signal, headers: this.headers() }),
        processEnded: this.processEnded,
        isExited: () => this.exited,
        exitMessage: () => this.exitMessage(),
      }, opts, this.role());
      try {
        await this.v2.start();
      } catch (err) {
        this.dispose();
        throw err;
      }
      this.sessionId = this.v2.nativeSessionId();
      return;
    }

    // A resume id names a session on disk, not on this process — so it is
    // checked rather than trusted.
    if (opts.resumeSessionId) {
      const existing = await this.json<{ id?: string }>('GET', `/session/${opts.resumeSessionId}`).catch(() => null);
      if (existing?.id) {
        this.sessionId = existing.id;
        // A resumed session already holds assistant messages. Without a
        // baseline, a recovery poll would accept one of those as this turn's
        // reply, so the newest is claimed as already-seen before any turn runs.
        const history = await this.json<OpenCodeMessageResponse[]>('GET', `/session/${existing.id}/message`).catch(() => null);
        this.lastAssistantId = this.newestAssistantId(history);
        return;
      }
      // A stale planner session degrades to a fresh one (T4), which the
      // caller reseeds from Ordewell's own transcript. A task's continue
      // without its session would run the message against none of the work
      // it continues, so it fails instead.
      if (opts.kind === 'task') {
        this.dispose();
        throw new Error(`OpenCode could not resume session ${opts.resumeSessionId}: the server does not know it.`);
      }
    }
    const created = await this.json<{ id?: string }>('POST', '/session', {});
    if (!created?.id) throw new Error(`The OpenCode ${this.role()} server did not return a session id.`);
    this.sessionId = created.id;
  }

  async send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
    if (!this.baseUrl || !this.sessionId) throw new Error(`OpenCode ${this.role()} session is not started`);
    if (this.exited) {
      onEvent({ type: 'error', message: this.exitMessage() });
      return;
    }
    if (this.v2) {
      await this.v2.send(message, onEvent, signal, onActivity);
      if (signal?.aborted) this.dispose();
      return;
    }
    if (this.task) return this.sendTask(this.task, message, onEvent, signal, onActivity);

    const turn = newTurnState();
    this.turnHasText = false;
    const closeStream = await this.openStream(turn, onEvent, onActivity);

    try {
      const model = this.planner?.model ? splitModelId(this.planner.model) : null;
      const body = {
        parts: [{ type: 'text', text: message }],
        // The read-only guarantee: OpenCode's own plan agent has no write tools.
        agent: 'plan',
        tools: DISABLED_TOOLS,
        ...(model ? { model } : {}),
        ...(this.planner?.effort ? { variant: this.planner.effort } : {}),
        ...(this.planner?.systemPrompt ? { system: this.planner.systemPrompt } : {}),
      };
      const reply = await this.json<OpenCodeMessageResponse>('POST', `/session/${this.sessionId}/message`, body, signal);

      if (signal?.aborted) { this.dispose(); return; }
      this.settle(reply, turn, onEvent);
    } catch (err) {
      if (signal?.aborted) { this.dispose(); return; }
      // The POST is the turn's transport, not its work: the server plans on
      // regardless of what happened to this socket. So a transport failure
      // reads the reply back out of the session rather than losing a turn the
      // server already finished (or is still finishing).
      const recovered = this.exited ? null : await this.recoverReply(signal, onActivity);
      if (recovered) { this.settle(recovered, turn, onEvent); return; }
      onEvent({ type: 'error', message: `The OpenCode planner turn failed: ${describeError(err)}` });
    } finally {
      await closeStream();
    }
  }

  /**
   * One task turn. `prompt_async` only queues the work, so the turn is over
   * when the session goes idle — OpenCode's own `run` rules: an idle frame
   * counts once `/session/status` confirms it, because a late idle can belong
   * to the turn before, and {@link pollStatus} stands behind the stream,
   * which can miss a status frame. No request is held open for the turn, so
   * fetch's 300s header timeout, the planner's reason for
   * {@link recoverReply}, never applies.
   */
  private async sendTask(
    task: TaskStartOptions,
    message: string,
    onEvent: (event: AgentEvent) => void,
    signal?: AbortSignal,
    onActivity?: () => void,
  ): Promise<void> {
    const state = newTurnState();
    this.turnHasText = false;
    this.interruptRequested = false;
    let markDone: () => void = () => {};
    const ended = new Promise<void>((resolve) => { markDone = resolve; });
    const turn: TaskTurn = { live: false, userMessages: new Set(), failure: null, messageError: null, done: false, ended, finish: () => { turn.done = true; markDone(); } };
    this.taskTurn = turn;
    const closeStream = await this.openStream(state, onEvent, onActivity);
    const poll = new AbortController();

    try {
      const model = task.model ? splitModelId(task.model) : null;
      const body = {
        parts: [{ type: 'text', text: message }],
        // The manifest's meaning of the task's mode (ADR-0001): for OpenCode a mode is an agent.
        agent: task.flags.permissionMode,
        tools: TASK_DISABLED_TOOLS,
        ...(model ? { model } : {}),
        ...(task.flags.effort ? { variant: task.flags.effort } : {}),
      };
      try {
        await this.json('POST', `/session/${this.sessionId}/prompt_async`, body, signal);
      } catch (err) {
        if (signal?.aborted) { this.dispose(); return; }
        onEvent({ type: 'error', message: `OpenCode did not take the message: ${describeError(err)}` });
        return;
      }

      void this.pollStatus(turn, poll.signal);
      const aborted = new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      await Promise.race([turn.ended, aborted, this.processEnded]);
      if (signal?.aborted) { this.dispose(); return; }
      if (!turn.done) { onEvent({ type: 'error', message: this.exitMessage() }); return; }

      await this.readBack(state, onEvent);
      // OpenCode asks only mid-turn and blocks on the answer, so a request
      // still open now was dropped by the abort that ended the turn.
      for (const id of [...this.openPermissions.keys()]) {
        this.openPermissions.delete(id);
        onEvent({ type: 'permission_cancelled', id });
      }
      const failure = turn.failure ?? turn.messageError;
      if (this.interruptRequested) onEvent({ type: 'turn_end', interrupted: true });
      else if (failure) onEvent({ type: 'error', message: failure });
      else onEvent({ type: 'turn_end' });
    } finally {
      this.taskTurn = null;
      poll.abort();
      await closeStream();
    }
  }

  /**
   * Whatever of the turn's own messages the stream missed. Each part is
   * emitted once, so a turn the stream saw whole adds nothing here; one that
   * lost its last text part still reaches the plain-text channel, where the
   * done marker is looked for.
   */
  private async readBack(turn: TurnState, onEvent: (e: AgentEvent) => void): Promise<void> {
    const messages = await this.json<OpenCodeMessageResponse[]>('GET', `/session/${this.sessionId}/message`).catch(() => null);
    if (!Array.isArray(messages)) return;
    let start = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.info?.role === 'user') { start = i + 1; break; }
    }
    for (const reply of messages.slice(start)) {
      const id = reply.info?.id;
      if (reply.info?.role !== 'assistant' || !id) continue;
      for (const part of reply.parts ?? []) {
        if (part.messageID === id) this.emitPart(part, turn, onEvent);
      }
      this.countUsage(reply.info, turn, onEvent);
    }
  }

  /**
   * The stream can drop a status frame while still delivering the rest, so a
   * task turn also reads the status itself. A busy session is this turn's own
   * work as surely as a frame is.
   */
  private async pollStatus(turn: TaskTurn, signal: AbortSignal): Promise<void> {
    while (!turn.done && !signal.aborted) {
      await delay(STATUS_POLL_INTERVAL_MS, signal);
      if (turn.done || signal.aborted) return;
      const busy = await this.sessionBusy();
      if (busy === true) turn.live = true;
      else if (busy === false && turn.live && !turn.done) turn.finish();
    }
  }

  /** An idle frame ends the turn only if the server agrees now. When it will not say, the frame is trusted, as upstream trusts it. */
  private async confirmIdle(turn: TaskTurn): Promise<void> {
    if (turn.done || !turn.live) return;
    if ((await this.sessionBusy()) !== true && !turn.done) turn.finish();
  }

  /** Whether the task's session is working, or null when the server will not say. A session absent from the map is idle. */
  private async sessionBusy(): Promise<boolean | null> {
    const statuses = await this.json<Record<string, { type?: string } | undefined>>('GET', '/session/status').catch(() => null);
    if (!statuses || typeof statuses !== 'object') return null;
    const type = statuses[this.sessionId ?? '']?.type;
    return type !== undefined && type !== 'idle';
  }

  /** What a frame of the task's own session says about the turn's end. */
  private followTaskTurn(frame: OpenCodeEvent, turn: TaskTurn): void {
    const props = frame.properties ?? {};
    if ((frame.type === 'session.status' && props.status?.type === 'idle') || frame.type === 'session.idle') {
      void this.confirmIdle(turn);
      return;
    }
    if (frame.type === 'message.updated' && props.info?.role === 'user') {
      if (props.info.id) turn.userMessages.add(props.info.id);
      return;
    }
    // Only the model's work counts: the session is retitled and the prompt
    // stored before it is scheduled, and a poll in that gap reads "not busy".
    const partOf = frame.type === 'message.part.updated' || frame.type === 'message.part.delta'
      ? props.part?.messageID ?? props.messageID
      : undefined;
    const working =
      (frame.type === 'session.status' && props.status?.type !== undefined) ||
      (frame.type === 'message.updated' && props.info?.role === 'assistant') ||
      frame.type === 'session.error' ||
      (partOf !== undefined && !turn.userMessages.has(partOf));
    if (working) turn.live = true;
    if (frame.type === 'message.updated' && props.info?.role === 'assistant') {
      turn.messageError = props.info.error ? errorText(props.info.error) : null;
    } else if (frame.type === 'session.error' && props.error) {
      // An overflowing context is compacted and the turn carries on; when it
      // cannot be, the message itself carries the error.
      if (props.error.name !== 'ContextOverflowError') turn.failure = errorText(props.error);
      void this.confirmIdle(turn);
    }
  }

  /**
   * Abort the running turn, keeping the server and its session. OpenCode
   * acknowledges by going idle, which is also what ends the turn — as
   * interrupted, because the request is remembered.
   */
  async interrupt(timeoutMs: number): Promise<boolean> {
    if (!this.process || !this.sessionId || this.exited) return false;
    if (this.v2) return this.v2.interrupt(timeoutMs);
    const turn = this.taskTurn;
    this.interruptRequested = true;
    const posted = await this.json('POST', `/session/${this.sessionId}/abort`).then(() => true, () => false);
    if (!posted) return false;
    if (!turn || turn.done) return true;
    // Whatever the turn had shown so far, the idle after an abort is its end.
    turn.live = true;
    void this.confirmIdle(turn);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); });
    const acknowledged = await Promise.race([turn.ended.then(() => true), this.processEnded.then(() => false), timedOut]);
    clearTimeout(timer);
    return acknowledged;
  }

  onProcessExit(listener: (code: number) => void): void {
    void this.processEnded.then(() => listener(this.exitCode));
  }

  answerPermission(id: string, decision: ApprovalDecision): boolean {
    if (this.v2) return this.process ? this.v2.answerPermission(id, decision) : false;
    const sessionId = this.openPermissions.get(id);
    if (sessionId === undefined || !this.process) return false;
    this.openPermissions.delete(id);
    void this.replyPermission(id, sessionId, permissionReply(decision))
      .catch(() => { /* a server that forgot the request will not hang on it either */ });
    return true;
  }

  /**
   * OpenCode 2.x replaced the 1.x HTTP surface rather than extending it, and
   * only 2.x answers `/api/info` with its version. A 1.x server — or one that
   * answers with anything else — keeps the 1.x protocol this class speaks.
   */
  private async speaksV2(): Promise<boolean> {
    const info = await this.json<{ version?: unknown }>('GET', '/api/info').catch(() => null);
    return typeof info === 'object' && info !== null && typeof info.version === 'string';
  }

  private role(): 'planner' | 'task' {
    return this.task ? 'task' : 'planner';
  }

  /**
   * Turn one settled assistant message into events. The settled response is
   * authoritative: it names the assistant message, so its parts are the ones
   * that make up the reply. Parts already completed live are deduplicated;
   * anything the stream missed (including a stream that never connected)
   * arrives here.
   *
   * It is only the turn's *last* message, though. OpenCode writes one
   * assistant message per model call, so the calls before the final one —
   * their text, reasoning and usage — reach Ordewell over the stream or not at
   * all.
   */
  private settle(reply: OpenCodeMessageResponse | null, turn: TurnState, onEvent: (e: AgentEvent) => void): void {
    const failure = typeof reply?.error === 'string'
      ? reply.error
      : (reply?.error as { message?: string } | undefined)?.message ?? reply?.info?.error?.data?.message;
    if (failure) {
      onEvent({ type: 'error', message: failure });
      return;
    }
    const assistantId = reply?.info?.id;
    for (const part of reply?.parts ?? []) {
      if (part.type !== 'tool' && assistantId && part.messageID !== assistantId) continue;
      this.emitPart(part, turn, onEvent);
    }
    if (reply?.info) this.countUsage(reply.info, turn, onEvent);
    if (assistantId) this.lastAssistantId = assistantId;
    onEvent({ type: 'turn_end' });
  }

  /**
   * Poll the session for this turn's assistant message after the POST's socket
   * died under it. Node's global `fetch` is undici, which aborts a request
   * whose response headers have not arrived within 300s — and OpenCode sends
   * none until the turn is done, so any turn past five minutes fails as
   * `TypeError: fetch failed` while the server is still working. The message
   * exists server-side either way, so it is waited for and read back.
   *
   * A message that exists but has not completed is progress, not an answer:
   * it refreshes the watchdog and the poll continues.
   */
  private async recoverReply(signal: AbortSignal | undefined, onActivity?: () => void): Promise<OpenCodeMessageResponse | null> {
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
    for (;;) {
      if (signal?.aborted || this.exited || this.disposed || !this.sessionId) return null;
      const messages = await this.json<OpenCodeMessageResponse[]>('GET', `/session/${this.sessionId}/message`).catch(() => null);
      const pending = Array.isArray(messages)
        ? [...messages].reverse().find((m) => m.info?.role === 'assistant' && m.info.id && m.info.id !== this.lastAssistantId)
        : undefined;
      if (pending?.info?.time?.completed || pending?.info?.error) return pending;
      if (pending) onActivity?.();
      if (Date.now() >= deadline) return null;
      await delay(RECOVERY_POLL_INTERVAL_MS, signal);
    }
  }

  private newestAssistantId(messages: OpenCodeMessageResponse[] | null): string | null {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]?.info;
      if (info?.role === 'assistant' && info.id) return info.id;
    }
    return null;
  }

  /**
   * Emit one complete message part, once. OpenCode reports a tool part
   * repeatedly as it moves through pending → running → completed, so parts are
   * keyed by id and only the terminal state produces a result. A subagent's
   * text is its report to the planner, not the reply, so it is dropped; the
   * `task` call's result carries it.
   */
  private emitPart(part: OpenCodePart, turn: TurnState, onEvent: (e: AgentEvent) => void, subagentId?: string): void {
    if (!part?.type) return;
    const { seen } = turn;
    const id = part.id ?? part.callID ?? '';

    if (part.type === 'text' && part.text && !subagentId) {
      if (seen.has(`text:${id}`)) return;
      seen.add(`text:${id}`);
      // Some models open a message with a text part of nothing but newlines
      // before calling a tool. It says nothing, and as a paragraph of its own
      // it would push the real reply down by a blank one.
      if (!part.text.trim()) return;
      // One message can carry text on both sides of a tool call. Concatenated
      // raw they run together, so each part after the first opens a paragraph.
      const lead = turn.textRuns.get(id)?.lead ?? (this.turnHasText ? '\n\n' : '');
      onEvent({ type: 'assistant_text', text: `${lead}${part.text}` });
      this.turnHasText = true;
      return;
    }
    if (part.type === 'reasoning' && part.text) {
      if (seen.has(`reasoning:${id}`)) return;
      seen.add(`reasoning:${id}`);
      onEvent({ type: 'thinking', text: part.text, subagentId });
      return;
    }
    if (part.type !== 'tool') return;

    const callId = part.callID ?? id;
    const name = part.tool ?? 'tool';
    const status = part.state?.status;
    const input = part.state?.input;
    // A `pending` tool part carries no input yet, so announcing it there gave
    // every call an empty arg summary. Waiting for the first state that has
    // input costs a moment of liveness and buys a readable timeline.
    if (!seen.has(`call:${callId}`) && (status !== 'pending' || (input && Object.keys(input).length > 0))) {
      seen.add(`call:${callId}`);
      onEvent({ type: 'tool_call', id: callId, name, args: input ?? {}, subagentId });
    }
    if (name === 'task' && !subagentId) this.trackSubagent(part, callId, turn, onEvent);
    if ((status === 'completed' || status === 'error') && !seen.has(`result:${callId}`)) {
      seen.add(`result:${callId}`);
      onEvent({
        type: 'tool_result',
        id: callId,
        name,
        output: unwrapFileToolOutput(part.state?.output ?? part.state?.error ?? ''),
        success: status === 'completed',
        subagentId,
      });
    }
  }

  /**
   * A `task` call runs a subagent in a child session. The call's part names
   * that session once it exists, which is what ties the child's frames to the
   * call; the subagent ends when the call does. The part is restated at every
   * status change, and so is what it says here — the service reports each
   * start and finish once, and no finish for a call that never had a child.
   */
  private trackSubagent(part: OpenCodePart, callId: string, turn: TurnState, onEvent: (e: AgentEvent) => void): void {
    const state = part.state;
    const child = state?.metadata?.sessionId;
    if (child && !turn.children.get(child)) {
      const input = state?.input ?? {};
      const brief = typeof input.description === 'string' ? input.description : typeof input.prompt === 'string' ? input.prompt : '';
      const model = flatModelId(state?.metadata?.model?.providerID, state?.metadata?.model?.modelID);
      onEvent({ type: 'subagent_started', subagentId: callId, brief, ...(model ? { model } : {}) });
      turn.children.set(child, callId);
      const held = turn.heldFrames.get(child) ?? [];
      turn.heldFrames.delete(child);
      for (const frame of held) this.onFrame(frame, turn, onEvent);
    }
    const status = state?.status;
    if (status === 'completed' || status === 'error') {
      onEvent({
        type: 'subagent_finished',
        subagentId: callId,
        outcome: status === 'completed' ? 'done' : 'failed',
        digest: taskDigest(state?.output ?? state?.error ?? ''),
      });
    }
  }

  /**
   * One message's usage, once, when it has completed. Every assistant message
   * is one model call; until it completes its counts are zeros.
   */
  private countUsage(info: OpenCodeMessageInfo, turn: TurnState, onEvent: (e: AgentEvent) => void, subagentId?: string): void {
    if (info.role !== 'assistant' || !info.id || !info.time?.completed || turn.seen.has(`usage:${info.id}`)) return;
    turn.seen.add(`usage:${info.id}`);
    const record = usageRecord(info, subagentId);
    if (record) onEvent({ type: 'usage', record });
  }

  /**
   * One `/event` frame. Only the planner's session and its children are
   * followed: the server's stream is global, and another client's session is
   * none of this turn's business.
   */
  private onFrame(frame: OpenCodeEvent, turn: TurnState, onEvent: (e: AgentEvent) => void): void {
    const props = frame.properties;
    if (!props) return;
    if (frame.type === 'session.created') {
      if (props.info?.parentID === this.sessionId && props.info.id && !turn.children.has(props.info.id)) turn.children.set(props.info.id, null);
      return;
    }
    const session = props.sessionID;
    if (session && session !== this.sessionId && !turn.children.has(session)) return;
    if (session === this.sessionId && this.taskTurn) this.followTaskTurn(frame, this.taskTurn);
    // Answered before anything waits on the `task` call naming its session: a
    // subagent's request blocks the turn exactly as the session's own does.
    if (frame.type === 'permission.asked' || frame.type === 'permission.v2.asked') {
      if (this.task) this.askPermission(props, turn.seen, onEvent);
      else this.denyPermission(props, turn.seen, onEvent);
      return;
    }
    // Answered by OpenCode itself: a reject also refuses the session's other
    // requests and an `always` grants the ones it covers.
    if (frame.type === 'permission.replied' || frame.type === 'permission.v2.replied') {
      const id = props.requestID;
      if (id && this.openPermissions.delete(id)) onEvent({ type: 'permission_cancelled', id });
      return;
    }
    let subagentId: string | undefined;
    if (session && session !== this.sessionId) {
      const owner = turn.children.get(session);
      if (!owner) {
        turn.heldFrames.set(session, [...(turn.heldFrames.get(session) ?? []), frame]);
        return;
      }
      subagentId = owner;
    }

    if (frame.type === 'message.updated' && props.info) {
      if (props.info.role === 'assistant' && props.info.id) turn.assistantMessages.add(props.info.id);
      this.countUsage(props.info, turn, onEvent, subagentId);
      return;
    }
    if (frame.type === 'message.part.delta') {
      if (props.field !== 'text' || !props.partID || !props.delta) return;
      if (!props.messageID || !turn.assistantMessages.has(props.messageID)) return;
      const type = turn.partTypes.get(props.partID);
      if (type === 'reasoning') onEvent({ type: 'thinking_delta', text: props.delta, subagentId });
      else if (type === 'text' && !subagentId) this.onTextDelta(props.partID, props.delta, turn, onEvent);
      return;
    }
    const part = props.part;
    if (!part) return;
    if (part.type === 'tool') {
      this.emitPart(part, turn, onEvent, subagentId);
      return;
    }
    // The server replays the user's own message back as text parts, with no
    // role on the frame. Letting it through would put the user's goal into the
    // planner's reply, and a goal containing JSON would be parsed as the plan
    // — so a part counts only once `message.updated` has named its message an
    // assistant's.
    if (!part.id || !part.messageID || !turn.assistantMessages.has(part.messageID)) return;
    if (part.type === 'text' || part.type === 'reasoning') turn.partTypes.set(part.id, part.type);
    if (part.time?.end) this.emitPart(part, turn, onEvent, subagentId);
  }

  /**
   * Stream one piece of a reply text part. The part's paragraph break goes out
   * with its first visible delta, so the deltas add up to exactly the text the
   * completed part then re-sends; a part that is only whitespace so far is
   * held back, for the reason {@link emitPart} drops one.
   */
  private onTextDelta(partId: string, delta: string, turn: TurnState, onEvent: (e: AgentEvent) => void): void {
    if (turn.seen.has(`text:${partId}`)) return;
    const run = turn.textRuns.get(partId) ?? { held: '', lead: null };
    turn.textRuns.set(partId, run);
    if (run.lead !== null) {
      onEvent({ type: 'assistant_text_delta', text: delta });
      return;
    }
    run.held += delta;
    if (!run.held.trim()) return;
    run.lead = this.turnHasText ? '\n\n' : '';
    this.turnHasText = true;
    onEvent({ type: 'assistant_text_delta', text: `${run.lead}${run.held}` });
  }

  /**
   * Deny one permission request (T1). OpenCode blocks the turn until the
   * request is answered, so this must answer — `reject` rather than a silent
   * drop, which is the same "absent answer is a denial" invariant ADR-0008
   * states for Ordewell's own tools. The refusal is announced so the timeline
   * shows the planner reaching for something it may not have.
   */
  private denyPermission(ask: OpenCodePermissionAsk, seen: Set<string>, onEvent: (e: AgentEvent) => void): void {
    const id = ask.id;
    if (!id || seen.has(`perm:${id}`)) return;
    seen.add(`perm:${id}`);
    onEvent({ type: 'permission_request', id, name: permissionName(ask), detail: permissionDetail(ask) });
    void this.replyPermission(id, ask.sessionID ?? this.sessionId ?? '', { reply: 'reject' })
      .catch(() => { /* a server that forgot the request will not hang on it either */ });
  }

  /**
   * A task's request. Under a mode whose manifest sets `approvals: auto` —
   * `build`, which the terminal transport runs with `--auto` — it is answered
   * at once with what `run --auto` answers, so the same plan behaves the same
   * on both transports (ADR-0001), and announced already decided so the log
   * still shows it. Any other mode leaves it open for an approval card.
   */
  private askPermission(ask: OpenCodePermissionAsk, seen: Set<string>, onEvent: (e: AgentEvent) => void): void {
    const id = ask.id;
    if (!id || seen.has(`perm:${id}`)) return;
    seen.add(`perm:${id}`);
    const sessionId = ask.sessionID ?? this.sessionId ?? '';
    const request: Extract<AgentEvent, { type: 'permission_request' }> = {
      type: 'permission_request',
      id,
      name: permissionName(ask),
      detail: permissionDetail(ask),
      input: ask.metadata ?? {},
      // The patterns `always` would grant: the runner's own offer, and the only grounds for "Allow for this task".
      ...(ask.always?.length ? { suggestions: ask.always } : {}),
      ...(ask.tool?.callID ? { toolUseId: ask.tool.callID } : {}),
    };
    if (this.task?.flags.modeSettings.approvals === AUTO_APPROVALS) {
      onEvent({ ...request, decided: { decision: 'allow' } });
      void this.replyPermission(id, sessionId, { reply: 'once' }).catch(() => { /* see answerPermission */ });
      return;
    }
    this.openPermissions.set(id, sessionId);
    onEvent(request);
  }

  /**
   * `POST /permission/:id/reply` is the current answer. The per-session path
   * it replaced is tried only when a server too old to know the new one 404s.
   */
  private async replyPermission(id: string, sessionId: string, reply: { reply: 'once' | 'always' | 'reject'; message?: string }): Promise<void> {
    const response = await this.request('POST', `/permission/${id}/reply`, reply);
    if (response.status !== 404) return;
    await this.request('POST', `/session/${sessionId}/permissions/${id}`, { response: reply.reply });
  }

  /**
   * Open `/event` for one turn and wait until it is connected. The stream
   * stopped being best-effort the moment permission answers moved onto it: a
   * request raised before we connect is one nobody answers, and the turn
   * hangs on it. Waiting is bounded so a server that never opens `/event`
   * still gets its turn.
   */
  private async openStream(turn: TurnState, onEvent: (e: AgentEvent) => void, onActivity?: () => void): Promise<() => Promise<void>> {
    const streamAbort = new AbortController();
    let connected: () => void = () => {};
    const streamReady = new Promise<void>((resolve) => { connected = resolve; });
    const live = this.streamEvents(streamAbort.signal, (frame) => this.onFrame(frame, turn, onEvent), connected, onActivity);
    await Promise.race([streamReady, new Promise<void>((r) => { const t = setTimeout(r, STREAM_CONNECT_TIMEOUT_MS); t.unref?.(); })]);
    return async () => {
      streamAbort.abort();
      await live.catch(() => { /* the stream is best-effort */ });
    };
  }

  /**
   * Server-sent events from `/event`: the turn's live text, reasoning, tool
   * activity and usage, and the only channel permission requests arrive on —
   * so the stream is load-bearing for {@link denyPermission}.
   */
  private async streamEvents(
    signal: AbortSignal,
    onFrame: (frame: OpenCodeEvent) => void,
    onConnected: () => void,
    onActivity?: () => void,
  ): Promise<void> {
    const response = await this.deps.fetch(`${this.baseUrl}/event`, { signal, headers: this.headers() }).catch(() => null);
    const body = response?.body;
    if (!body) { onConnected(); return; }
    onConnected();
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      // Any bytes at all mean the server is still talking, independent of
      // whether this chunk resolves into a part this adapter forwards —
      // the same gap that made Claude Code's watchdog false-positive on
      // filtered subagent output, closed here before it can recur.
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        try {
          onFrame(JSON.parse(line.slice(5).trim()) as OpenCodeEvent);
        } catch {
          // A partial or unrecognized frame costs one event, not the turn.
        }
      }
    }
  }

  private async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T | null> {
    const response = await this.request(method, path, body, signal);
    if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${response.statusText}`);
    return (await response.json().catch(() => null)) as T | null;
  }

  private request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    return this.deps.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers({ 'content-type': 'application/json' }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.authorization ? { ...extra, authorization: this.authorization } : extra;
  }

  nativeSessionId(): string | null { return this.sessionId; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const proc = this.process;
    this.process = null;
    this.baseUrl = null;
    // Tree-wide: `opencode serve` is a server, and on Windows it may sit behind
    // a cmd.exe shim. A surviving server keeps the port and the session.
    killTree(proc, { platform: this.deps.platform });
  }

  private exitMessage(): string {
    const tail = this.stderrTail.trim();
    return `The OpenCode ${this.role()} server exited.${tail ? `\n\n${tail}` : ''}`;
  }
}
