import { partedPromptUsage, type UsageRecord } from '../../models/Usage';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { AgentEvent, PlannerStartOptions, TaskStartOptions } from './AgentAdapter';
import { isOrdewellTool, ordewellToolPrefix } from './openCodeOrdewell';

/** How long a turn waits for `/api/event` before posting anyway. */
const STREAM_CONNECT_TIMEOUT_MS = 5000;
/** A turn's end is also read from `/api/session/active`, behind the stream, which can drop a frame. */
const ACTIVE_POLL_INTERVAL_MS = 1000;
/** Polls that find the session inactive before any frame of this turn arrived, after which it is taken as already over. */
const IDLE_POLLS_BEFORE_START = 3;

/**
 * Asked of the planner's session, which nobody is watching. `question` blocks
 * the turn on an answer that cannot come; a denied request makes the model say
 * so in text. `edit` is the write tools, withheld for the reason ADR-0009 gives
 * for the plan agent alone not being the guarantee.
 */
const PLANNER_RULES: SessionRule[] = [
  { action: 'question', resource: '*', effect: 'deny' },
  { action: 'edit', resource: '*', effect: 'deny' },
];
/** A task asks its user in plain text for now, as it does on every transport. */
const TASK_RULES: SessionRule[] = [{ action: 'question', resource: '*', effect: 'deny' }];

const AUTO_APPROVALS = 'auto';

interface SessionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

interface V2Model {
  id: string;
  providerID: string;
  variant?: string;
}

interface V2Tokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

interface V2ToolContent {
  type?: string;
  text?: string;
}

/** One `/api/event` frame, narrowed to the fields read here. */
interface V2Frame {
  type?: string;
  data?: {
    sessionID?: string;
    parentID?: string;
    assistantMessageID?: string;
    ordinal?: number;
    delta?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    content?: V2ToolContent[];
    error?: { type?: string; message?: string };
    model?: { id?: string; providerID?: string };
    cost?: number;
    tokens?: V2Tokens;
    requestID?: string;
    action?: string;
    resources?: string[];
    save?: string[];
    source?: { type?: string; messageID?: string; id?: string };
    metadata?: { sessionID?: string; status?: string };
  };
}

interface V2Message {
  id?: string;
  type?: string;
  outcome?: string;
  content?: Array<{ type?: string; text?: string }>;
}

/** What the adapter that owns the server lends this module. */
export interface OpenCodeV2Host {
  request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response>;
  /** A request whose body is the answer or throws, as `request` + status check. */
  json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T | null>;
  /** The server's event stream, as `data:` frames. */
  openEvents(signal: AbortSignal): Promise<Response | null>;
  /** Resolves when the server process is gone. */
  processEnded: Promise<void>;
  isExited(): boolean;
  exitMessage(): string;
}

interface TurnState {
  seen: Set<string>;
  /** Tool call id → tool name, from `session.tool.input.started`; `tool.called` carries no name. */
  toolNames: Map<string, string>;
  /** Assistant message id → the model that ran it, from `session.step.started`. */
  stepModels: Map<string, string>;
  textRuns: Map<string, { held: string; lead: string | null }>;
  /** Child sessions of this session, mapped to the tool call that spawned each once it names it. */
  children: Map<string, string | null>;
  /** A delegation call's own id and its brief, remembered so `subagent_started` can name it. */
  briefs: Map<string, string>;
  /** Frames from a child session that arrived before the call that owns it was named. */
  heldFrames: Map<string, V2Frame[]>;
  /** Assistant messages whose text the stream delivered, so a read-back does not repeat them. */
  streamedMessages: Set<string>;
}

interface Turn {
  /** This turn's own work has begun, so an end frame or an idle session is this turn's. */
  live: boolean;
  done: boolean;
  outcome: 'succeeded' | 'failed' | 'interrupted' | null;
  failure: string | null;
  finish: () => void;
  ended: Promise<void>;
}

function newTurnState(): TurnState {
  return { seen: new Set(), toolNames: new Map(), stepModels: new Map(), textRuns: new Map(), children: new Map(), briefs: new Map(), heldFrames: new Map(), streamedMessages: new Set() };
}

function splitModelId(id: string): { providerID: string; id: string } | null {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return null;
  return { providerID: id.slice(0, slash), id: id.slice(slash + 1) };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function contentText(content: V2ToolContent[] | undefined): string {
  return (content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
}

/** The subagent's report without the `<subagent …>` envelope the delegating tool wraps it in. */
function subagentDigest(output: string): string {
  const inner = output.match(/<subagent[^>]*>\n?([\s\S]*?)\n?<\/subagent>/);
  return inner ? inner[1] : output;
}

function permissionReply(decision: ApprovalDecision): { decision: 'once' | 'always' | 'reject'; message?: string } {
  if (decision.decision === 'allow') return { decision: 'once' };
  if (decision.decision === 'allowForTask') return { decision: 'always' };
  const note = decision.note?.trim();
  // With a message OpenCode hands the note to the agent as a correction; without one it is a bare refusal.
  return note ? { decision: 'reject', message: note } : { decision: 'reject' };
}

/**
 * OpenCode's 2.x server (`opencode serve`, the `/api` surface), as a planner
 * or a task runner. The 1.x surface it replaced is {@link OpenCodeAdapter}'s own.
 *
 * What differs, and why this is a module of its own: a session carries its
 * model, agent and permission rules rather than each message, a prompt is
 * always queued and returns at once, and a turn ends on a `session.execution.*`
 * frame — so planner and task turns read the same way, from the stream with
 * `/api/session/active` behind it.
 */
export class OpenCodeV2 {
  private sessionId: string | null = null;
  private model: V2Model | null = null;
  private agent: string;
  private turn: Turn | null = null;
  private turnHasText = false;
  private interruptRequested = false;
  /** A task's requests waiting for an answer, by request id, with the session that asked. */
  private readonly openPermissions = new Map<string, string>();

  constructor(
    private host: OpenCodeV2Host,
    private opts: PlannerStartOptions | TaskStartOptions,
    private role: 'planner' | 'task',
  ) {
    this.agent = opts.kind === 'task' ? opts.flags.permissionMode : 'plan';
    const split = opts.model ? splitModelId(opts.model) : null;
    const variant = opts.kind === 'task' ? opts.flags.effort : opts.effort;
    if (split) this.model = { ...split, ...(variant ? { variant } : {}) };
  }

  nativeSessionId(): string | null { return this.sessionId; }

  async start(): Promise<void> {
    const resume = this.opts.resumeSessionId;
    if (resume) {
      // A resume id names a session on disk, not on this process — so it is checked rather than trusted.
      const existing = await this.host.json<{ data?: { id?: string } }>('GET', `/api/session/${resume}`).catch(() => null);
      if (existing?.data?.id) {
        this.sessionId = existing.data.id;
        // The session keeps the model and agent it last ran with, which the plan may have changed since.
        if (this.model) await this.host.request('POST', `/api/session/${this.sessionId}/model`, { model: this.model }).catch(() => undefined);
        await this.host.request('POST', `/api/session/${this.sessionId}/agent`, { agent: this.agent }).catch(() => undefined);
        await this.applyInstructions();
        return;
      }
      // A stale planner session degrades to a fresh one, which the caller reseeds from Ordewell's own
      // transcript. A task's continue without its session would run against none of the work it continues.
      if (this.opts.kind === 'task') throw new Error(`OpenCode could not resume session ${resume}: the server does not know it.`);
    }
    const created = await this.host.json<{ data?: { id?: string } }>('POST', '/api/session', {
      agent: this.agent,
      ...(this.model ? { model: this.model } : {}),
      permissions: [...(this.role === 'planner' ? PLANNER_RULES : TASK_RULES), ...this.ordewellRules()],
    });
    if (!created?.data?.id) throw new Error(`The OpenCode ${this.role} server did not return a session id.`);
    this.sessionId = created.data.id;
    await this.applyInstructions();
  }

  /** Allow the Ordewell server's tools, so a call never waits on a person (ADR-0022, S3). */
  private ordewellRules(): SessionRule[] {
    return this.opts.mcp ? [{ action: `${ordewellToolPrefix(this.opts.mcp)}*`, resource: '*', effect: 'allow' }] : [];
  }

  /** The planner's system prompt rides on the session as an instruction entry — a prompt has no system field. */
  private async applyInstructions(): Promise<void> {
    if (this.opts.kind !== 'planner' || !this.opts.systemPrompt) return;
    const response = await this.host.request('PUT', `/api/experimental/session/${this.sessionId}/instructions/entries/ordewell-planner`, { value: this.opts.systemPrompt });
    if (!response.ok) throw new Error(`OpenCode did not take the planner instructions: ${response.status} ${response.statusText}`);
  }

  async send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
    if (!this.sessionId) throw new Error(`OpenCode ${this.role} session is not started`);
    if (this.host.isExited()) {
      onEvent({ type: 'error', message: this.host.exitMessage() });
      return;
    }
    const state = newTurnState();
    this.turnHasText = false;
    this.interruptRequested = false;
    let markDone: () => void = () => {};
    const ended = new Promise<void>((resolve) => { markDone = resolve; });
    const turn: Turn = { live: false, done: false, outcome: null, failure: null, ended, finish: () => { turn.done = true; markDone(); } };
    this.turn = turn;
    const closeStream = await this.openStream(state, turn, onEvent, onActivity);
    const poll = new AbortController();

    try {
      try {
        await this.host.json('POST', `/api/session/${this.sessionId}/prompt`, { text: message }, signal);
      } catch (err) {
        if (signal?.aborted) return;
        onEvent({ type: 'error', message: `OpenCode did not take the message: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }

      void this.pollActive(turn, poll.signal);
      const aborted = new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      await Promise.race([turn.ended, aborted, this.host.processEnded]);
      if (signal?.aborted) return;
      if (!turn.done) { onEvent({ type: 'error', message: this.host.exitMessage() }); return; }

      await this.readBack(state, onEvent);
      // OpenCode asks only mid-turn and blocks on the answer, so a request still open now was dropped by the abort that ended the turn.
      for (const id of [...this.openPermissions.keys()]) {
        this.openPermissions.delete(id);
        onEvent({ type: 'permission_cancelled', id });
      }
      if (turn.outcome === 'interrupted' || this.interruptRequested) onEvent({ type: 'turn_end', interrupted: true });
      else if (turn.outcome === 'failed') onEvent({ type: 'error', message: turn.failure ?? 'OpenCode reported that the turn failed.' });
      else onEvent({ type: 'turn_end' });
    } finally {
      this.turn = null;
      poll.abort();
      await closeStream();
    }
  }

  /**
   * The stream can drop the end frame while still delivering the rest, so the
   * turn also asks which sessions are running. A session that is not, after
   * this turn's work was seen, is over; one never seen working after a few
   * polls had already finished before the stream connected.
   */
  private async pollActive(turn: Turn, signal: AbortSignal): Promise<void> {
    let idlePolls = 0;
    while (!turn.done && !signal.aborted) {
      await delay(ACTIVE_POLL_INTERVAL_MS, signal);
      if (turn.done || signal.aborted) return;
      const active = await this.host.json<{ data?: Record<string, unknown> }>('GET', '/api/session/active').catch(() => null);
      if (!active?.data) continue;
      if (this.sessionId && this.sessionId in active.data) {
        turn.live = true;
        idlePolls = 0;
        continue;
      }
      idlePolls++;
      if (turn.live || idlePolls >= IDLE_POLLS_BEFORE_START) {
        // The idle message at the end of the session says how it ended.
        const messages = await this.messages();
        const idle = [...(messages ?? [])].reverse().find((m) => m.type === 'idle');
        if (idle?.outcome === 'failed' || idle?.outcome === 'interrupted' || idle?.outcome === 'succeeded') turn.outcome ??= idle.outcome;
        turn.outcome ??= 'succeeded';
        if (!turn.done) turn.finish();
      }
    }
  }

  private async messages(): Promise<V2Message[] | null> {
    const response = await this.host.json<{ data?: V2Message[] }>('GET', `/api/session/${this.sessionId}/message`).catch(() => null);
    return Array.isArray(response?.data) ? response.data : null;
  }

  /**
   * Whatever of the turn's own replies the stream missed. A message whose text
   * the stream delivered adds nothing here; one that lost its text frames still
   * reaches the plain-text channel, where the done marker is looked for.
   */
  private async readBack(state: TurnState, onEvent: (e: AgentEvent) => void): Promise<void> {
    const messages = await this.messages();
    if (!messages) return;
    // The server lists newest first, so this turn's own replies are the ones before the latest user message.
    const latestUser = messages.findIndex((m) => m.type === 'user');
    const own = latestUser < 0 ? messages : messages.slice(0, latestUser);
    for (const message of [...own].reverse()) {
      if (message.type !== 'assistant' || !message.id || state.streamedMessages.has(message.id)) continue;
      (message.content ?? []).forEach((part, index) => {
        if (part.type === 'text' && part.text) this.emitText(`${message.id}:readback:${index}`, part.text, state, onEvent);
      });
    }
  }

  /**
   * Abort the running turn, keeping the server and its session. OpenCode
   * acknowledges with `session.execution.interrupted`, which also ends the turn.
   */
  async interrupt(timeoutMs: number): Promise<boolean> {
    if (!this.sessionId || this.host.isExited()) return false;
    const turn = this.turn;
    this.interruptRequested = true;
    const response = await this.host.json<{ interrupted?: boolean }>('POST', `/api/session/${this.sessionId}/interrupt`).catch(() => null);
    if (!response) return false;
    if (!turn || turn.done) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); });
    const acknowledged = await Promise.race([turn.ended.then(() => true), this.host.processEnded.then(() => false), timedOut]);
    clearTimeout(timer);
    return acknowledged;
  }

  answerPermission(id: string, decision: ApprovalDecision): boolean {
    const sessionId = this.openPermissions.get(id);
    if (sessionId === undefined) return false;
    this.openPermissions.delete(id);
    void this.replyPermission(id, sessionId, permissionReply(decision))
      .catch(() => { /* a server that forgot the request will not hang on it either */ });
    return true;
  }

  private async replyPermission(id: string, sessionId: string, reply: { decision: 'once' | 'always' | 'reject'; message?: string }): Promise<void> {
    await this.host.request('POST', `/api/session/${sessionId}/permission/${id}/reply`, reply);
  }

  private async openStream(state: TurnState, turn: Turn, onEvent: (e: AgentEvent) => void, onActivity?: () => void): Promise<() => Promise<void>> {
    const streamAbort = new AbortController();
    let connected: () => void = () => {};
    const ready = new Promise<void>((resolve) => { connected = resolve; });
    const live = this.streamEvents(streamAbort.signal, (frame) => this.onFrame(frame, state, turn, onEvent), connected, onActivity);
    // Permission answers ride this stream, so a request raised before it connects is one nobody answers.
    // Waiting is bounded so a server that never opens it still gets its turn.
    await Promise.race([ready, new Promise<void>((r) => { const t = setTimeout(r, STREAM_CONNECT_TIMEOUT_MS); t.unref?.(); })]);
    return async () => {
      streamAbort.abort();
      await live.catch(() => { /* the stream is best-effort */ });
    };
  }

  private async streamEvents(signal: AbortSignal, onFrame: (frame: V2Frame) => void, onConnected: () => void, onActivity?: () => void): Promise<void> {
    const response = await this.host.openEvents(signal).catch(() => null);
    const body = response?.body;
    if (!body) { onConnected(); return; }
    onConnected();
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      // Any bytes mean the server is still talking, whether or not the chunk becomes an event.
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        try {
          onFrame(JSON.parse(line.slice(5).trim()) as V2Frame);
        } catch {
          // A partial or unrecognized frame costs one event, not the turn.
        }
      }
    }
  }

  /**
   * One frame. Only this session and its children are followed: the stream is
   * the whole server's, and another client's session is none of this turn's business.
   */
  private onFrame(frame: V2Frame, state: TurnState, turn: Turn, onEvent: (e: AgentEvent) => void): void {
    const data = frame.data;
    if (!data || !frame.type) return;
    if (frame.type === 'session.created') {
      if (data.parentID && data.parentID === this.sessionId && data.sessionID && !state.children.has(data.sessionID)) state.children.set(data.sessionID, null);
      return;
    }
    const session = data.sessionID;
    if (!session) return;
    const isChild = session !== this.sessionId;
    if (isChild && !state.children.has(session)) return;

    if (!isChild) {
      if (frame.type === 'session.execution.started') { turn.live = true; return; }
      if (frame.type === 'session.execution.succeeded' || frame.type === 'session.execution.failed' || frame.type === 'session.execution.interrupted') {
        if (!turn.live || turn.done) return;
        turn.outcome = frame.type === 'session.execution.succeeded' ? 'succeeded' : frame.type === 'session.execution.failed' ? 'failed' : 'interrupted';
        if (turn.outcome === 'failed') turn.failure = data.error?.message ?? data.error?.type ?? null;
        turn.finish();
        return;
      }
    }

    // Answered before anything waits on the delegating call naming its session: a subagent's
    // request blocks the turn exactly as the session's own does.
    if (frame.type === 'permission.asked') {
      if (this.role === 'task') this.askPermission(data, session, state, onEvent);
      else this.denyPermission(data, session, state, onEvent);
      return;
    }
    if (frame.type === 'permission.replied') {
      const id = data.requestID;
      if (id && this.openPermissions.delete(id)) onEvent({ type: 'permission_cancelled', id });
      return;
    }

    let subagentId: string | undefined;
    if (isChild) {
      const owner = state.children.get(session);
      if (!owner) {
        state.heldFrames.set(session, [...(state.heldFrames.get(session) ?? []), frame]);
        return;
      }
      subagentId = owner;
    }
    this.onContentFrame(frame, data, state, turn, onEvent, subagentId);
  }

  private onContentFrame(frame: V2Frame, data: NonNullable<V2Frame['data']>, state: TurnState, turn: Turn, onEvent: (e: AgentEvent) => void, subagentId?: string): void {
    const message = data.assistantMessageID ?? '';
    switch (frame.type) {
      case 'session.step.started':
        if (message && data.model?.providerID && data.model.id) state.stepModels.set(message, `${data.model.providerID}/${data.model.id}`);
        return;
      case 'session.reasoning.delta':
        if (data.delta) onEvent({ type: 'thinking_delta', text: data.delta, subagentId });
        return;
      case 'session.reasoning.ended': {
        const key = `reasoning:${message}:${data.ordinal ?? 0}`;
        if (!data.text || state.seen.has(key)) return;
        state.seen.add(key);
        onEvent({ type: 'thinking', text: data.text, subagentId });
        return;
      }
      case 'session.text.delta':
        // A subagent's text is its report to its caller, not the reply; the delegating call's result carries it.
        if (!subagentId && data.delta) this.onTextDelta(`${message}:${data.ordinal ?? 0}`, data.delta, state, onEvent);
        return;
      case 'session.text.ended':
        if (subagentId || !data.text) return;
        if (message) state.streamedMessages.add(message);
        this.emitText(`${message}:${data.ordinal ?? 0}`, data.text, state, onEvent);
        return;
      case 'session.tool.input.started':
        if (data.id && data.name) state.toolNames.set(data.id, data.name);
        return;
      case 'session.tool.called': {
        const id = data.id;
        if (!id || state.seen.has(`call:${id}`)) return;
        state.seen.add(`call:${id}`);
        const input = data.input ?? {};
        const name = state.toolNames.get(id) ?? 'tool';
        const brief = typeof input.description === 'string' ? input.description : typeof input.prompt === 'string' ? input.prompt : '';
        state.briefs.set(id, brief);
        onEvent({ type: 'tool_call', id, name, args: input, subagentId });
        return;
      }
      case 'session.tool.progress':
        // A delegating call names the child session it runs once that exists, which is what ties the child's frames to it.
        if (!subagentId) this.adoptChild(data, state, onEvent, turn);
        return;
      case 'session.tool.success':
      case 'session.tool.failed': {
        const id = data.id;
        if (!id || state.seen.has(`result:${id}`)) return;
        state.seen.add(`result:${id}`);
        const success = frame.type === 'session.tool.success';
        const output = success ? contentText(data.content) : data.error?.message ?? data.error?.type ?? '';
        onEvent({ type: 'tool_result', id, name: state.toolNames.get(id) ?? 'tool', output, success, subagentId });
        if (!subagentId) this.finishChild(id, success, output, state, onEvent);
        return;
      }
      case 'session.step.ended':
      case 'session.step.failed':
        this.countUsage(data, state, onEvent, subagentId);
        return;
      default:
    }
  }

  private adoptChild(data: NonNullable<V2Frame['data']>, state: TurnState, onEvent: (e: AgentEvent) => void, turn: Turn): void {
    const child = data.metadata?.sessionID;
    const callId = data.id;
    if (!child || !callId || state.children.get(child)) return;
    const model = state.stepModels.get(data.assistantMessageID ?? '');
    onEvent({ type: 'subagent_started', subagentId: callId, brief: state.briefs.get(callId) ?? '', ...(model ? { model } : {}) });
    state.children.set(child, callId);
    const held = state.heldFrames.get(child) ?? [];
    state.heldFrames.delete(child);
    for (const frame of held) this.onFrame(frame, state, turn, onEvent);
  }

  private finishChild(callId: string, success: boolean, output: string, state: TurnState, onEvent: (e: AgentEvent) => void): void {
    if (![...state.children.values()].includes(callId)) return;
    onEvent({ type: 'subagent_finished', subagentId: callId, outcome: success ? 'done' : 'failed', digest: subagentDigest(output) });
  }

  /** One model call's usage, once, when its step ends. Zeros mean the call failed before the provider answered. */
  private countUsage(data: NonNullable<V2Frame['data']>, state: TurnState, onEvent: (e: AgentEvent) => void, subagentId?: string): void {
    const message = data.assistantMessageID;
    const tokens = data.tokens;
    if (!message || !tokens || state.seen.has(`usage:${message}`)) return;
    state.seen.add(`usage:${message}`);
    const prompt = partedPromptUsage({ uncached: tokens.input, cacheRead: tokens.cache?.read, cacheWrite: tokens.cache?.write });
    // Reasoning is billed as output, and OpenCode reports it beside the output count rather than inside it.
    const outputTokens = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
    if ((prompt.inputTokens ?? 0) + outputTokens === 0) return;
    const record: UsageRecord = { source: 'opencode', ...prompt, outputTokens };
    const model = state.stepModels.get(message);
    if (model) record.model = model;
    // OpenCode prices a call itself, so 0 is a free model or one its catalog cannot price — not a bill of nothing.
    if (typeof data.cost === 'number' && data.cost > 0) record.reportedCost = { amount: data.cost, currency: 'USD' };
    if (subagentId) record.subagentId = subagentId;
    onEvent({ type: 'usage', record });
  }

  /** One complete reply text, once. A message can carry text on both sides of a tool call, so each run after the first opens a paragraph. */
  private emitText(id: string, text: string, state: TurnState, onEvent: (e: AgentEvent) => void): void {
    if (state.seen.has(`text:${id}`)) return;
    state.seen.add(`text:${id}`);
    // Some models open a message with text of nothing but newlines before calling a tool; it says nothing.
    if (!text.trim()) return;
    const lead = state.textRuns.get(id)?.lead ?? (this.turnHasText ? '\n\n' : '');
    onEvent({ type: 'assistant_text', text: `${lead}${text}` });
    this.turnHasText = true;
  }

  /**
   * Stream one piece of a reply text. The paragraph break goes out with the
   * first visible delta, so the deltas add up to exactly the text the completed
   * run then re-sends; a run that is only whitespace so far is held back.
   */
  private onTextDelta(id: string, delta: string, state: TurnState, onEvent: (e: AgentEvent) => void): void {
    if (state.seen.has(`text:${id}`)) return;
    const run = state.textRuns.get(id) ?? { held: '', lead: null };
    state.textRuns.set(id, run);
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

  private permissionRequest(ask: NonNullable<V2Frame['data']>): Extract<AgentEvent, { type: 'permission_request' }> | null {
    const id = ask.id;
    if (!id) return null;
    const scope = (ask.resources ?? []).join(', ');
    return {
      type: 'permission_request',
      id,
      name: ask.action ?? 'permission',
      detail: JSON.stringify(scope ? { scope } : {}),
      input: ask.resources ? { resources: ask.resources } : {},
      // The patterns `always` would grant: the runner's own offer, and the only grounds for "Allow for this task".
      ...(ask.save?.length ? { suggestions: ask.save } : {}),
      ...(ask.source?.id ? { toolUseId: ask.source.id } : {}),
    };
  }

  /**
   * Deny one planner request. OpenCode blocks the turn until it is answered, so
   * this must answer: `reject` rather than a silent drop is the "absent answer
   * is a denial" invariant ADR-0008 states. The refusal is announced so the
   * timeline shows the planner reaching for something it may not have.
   */
  private denyPermission(ask: NonNullable<V2Frame['data']>, session: string, state: TurnState, onEvent: (e: AgentEvent) => void): void {
    const request = this.permissionRequest(ask);
    if (!request || state.seen.has(`perm:${request.id}`)) return;
    state.seen.add(`perm:${request.id}`);
    if (isOrdewellTool(this.opts.mcp, request.name)) {
      void this.replyPermission(request.id, session, { decision: 'once' }).catch(() => { /* see answerPermission */ });
      return;
    }
    onEvent(request);
    void this.replyPermission(request.id, session, { decision: 'reject' })
      .catch(() => { /* see answerPermission */ });
  }

  /**
   * A task's request. Under a mode whose manifest sets `approvals: auto` it is
   * answered at once with what `opencode run --auto` answers, so the same plan
   * behaves the same on both transports (ADR-0001), and announced already
   * decided so the log still shows it. Any other mode leaves it open for an
   * approval card.
   */
  private askPermission(ask: NonNullable<V2Frame['data']>, session: string, state: TurnState, onEvent: (e: AgentEvent) => void): void {
    const request = this.permissionRequest(ask);
    if (!request || state.seen.has(`perm:${request.id}`)) return;
    state.seen.add(`perm:${request.id}`);
    if (isOrdewellTool(this.opts.mcp, request.name) || (this.opts.kind === 'task' && this.opts.flags.modeSettings.approvals === AUTO_APPROVALS)) {
      onEvent({ ...request, decided: { decision: 'allow' } });
      void this.replyPermission(request.id, session, { decision: 'once' }).catch(() => { /* see answerPermission */ });
      return;
    }
    this.openPermissions.set(request.id, session);
    onEvent(request);
  }
}
