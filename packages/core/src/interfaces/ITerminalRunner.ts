import type { AgentEvent } from '../services/harness/AgentAdapter';
import type { TaskCompleteArgs } from '../services/mcp/tools';
import type { ApprovalDecision } from './IApproval';

export interface ITerminalSession {
  id: string;
  taskId: string;
  onOutput(callback: (text: string) => void): void;
  onExit(callback: (code: number) => void): void;
  kill(): void;
  getOutput(): string;
  write(text: string): void;
  /**
   * True when the session runs the agent as a raw-mode TUI (a real PTY for the
   * VS Code terminal, a tmux window). Such a surface submits an input line on
   * the Enter keystroke (`\r`), so a synchronized resume token terminated with
   * `\n` only types the line and never sends it. A line-oriented piped session
   * (`defaultInteractive = false`) leaves this false and accepts `\n`.
   */
  readonly interactive?: boolean;
  /**
   * Optional transport-level control channel: PTY resize requests for a session
   * whose runner renders a TUI. Absent on transports without a resizable PTY
   * (a plain piped subprocess); surfaces must feature-detect before calling.
   */
  writeControl?(text: string): void;
}

/**
 * How Ordewell drives a task's runner (ADR-0018): through its screen and
 * keyboard, or through its programmatic protocol.
 */
export type RunnerTransport = 'terminal' | 'structured';

export function isRunnerTransport(value: unknown): value is RunnerTransport {
  return value === 'terminal' || value === 'structured';
}

/** How a structured turn ended. `failed` carries the agent's own words in the preceding `error` event. */
export type StructuredTurnEnd = 'completed' | 'interrupted' | 'failed';

/**
 * One normalized event from a structured task (ADR-0018, O1b): the adapter's
 * events, with the turn made explicit at both ends and the message queue (M1)
 * alongside. Subagent work carries its `subagentId`. The source for the
 * full-fidelity task log, never for verdicts.
 */
export type StructuredEvent =
  | Exclude<AgentEvent, { type: 'turn_end' } | { type: 'permission_cancelled' }>
  /** `text` is the user message the turn answers; `messageId` is set when it had waited in the queue. */
  | { type: 'turn_start'; text: string; messageId?: string }
  | { type: 'turn_end'; reason: StructuredTurnEnd }
  | { type: 'message_queued'; messageId: string; text: string }
  | { type: 'message_removed'; messageId: string }
  /** An open `permission_request` was answered, by whoever answered it (ADR-0018, A1). */
  | { type: 'permission_decided'; id: string; decision: ApprovalDecision }
  /** An open `permission_request` can no longer be answered: the runner withdrew it, or its process is gone. */
  | { type: 'permission_withdrawn'; id: string };

export interface QueuedTaskMessage {
  id: string;
  text: string;
}

/**
 * What a session driven over its runner's protocol can do that a terminal
 * cannot (ADR-0018, S2). Optional: callers feature-detect it with
 * {@link isStructuredSession}, and code that does not look behaves as it did.
 */
export interface StructuredSessionCapability {
  readonly transport: 'structured';
  /** `working` while a turn runs; `idle` between turns, waiting for a message. */
  turnState(): 'working' | 'idle';
  onTurnEnd(listener: (reason: StructuredTurnEnd) => void): void;
  onEvent(listener: (event: StructuredEvent) => void): void;
  /**
   * Queue a user message, delivered when the current turn ends — or at once
   * when idle. Returns its id, for {@link removeQueued}.
   */
  sendMessage(text: string): string;
  /** Take a message back before it is delivered. False when it already was. */
  removeQueued(id: string): boolean;
  /** Messages waiting for the current turn to end, oldest first. */
  queued(): QueuedTaskMessage[];
  /**
   * Stop the running turn, keeping the session: a soft interrupt first, then —
   * if the runner does not answer in time — kill and resume. Either way the
   * turn ends `interrupted`. Resolves once it has.
   */
  interrupt(): Promise<void>;
  /** The runner's own session id once announced — what a continue resumes (ADR-0018, K1). */
  nativeSessionId(): string | null;
  /**
   * Answer a `permission_request` this session emitted, by its event id. False
   * when it is no longer open — answered, withdrawn, or never asked.
   */
  answerPermission(id: string, decision: ApprovalDecision): boolean;
  /**
   * The runner's `task_complete` calls on this attempt's token (ADR-0022):
   * completion evidence beside the marker, for `VerdictEngine` to weigh.
   */
  onTaskComplete(listener: (report: TaskCompleteArgs) => void): void;
}

export function isStructuredSession(session: ITerminalSession): session is ITerminalSession & StructuredSessionCapability {
  return (session as Partial<StructuredSessionCapability>).transport === 'structured';
}

import type { RunnerRegistry } from '../plugins/RunnerRegistry';

export interface ITerminalRunner {
  spawn(opts: {
    taskId: string;
    runner: string;
    prompt: string;
    modelId?: string;
    thinkingEffort?: string;
    modelVariants?: string[];
    mode?: string;
    headless?: boolean;
    cwd: string;
    registry?: RunnerRegistry;
    /** Task order and title — surfaces use these to label task_started/output events. */
    order?: number;
    title?: string;
    /**
     * The owning plan session. Task ids are only unique within one plan, so
     * transports that key OS resources by task (tmux windows, log files) need
     * this to keep two plans' identically named tasks apart.
     */
    planSessionId?: string;
    /**
     * The workspace's own variables (ADR-0016), under the runner's: a
     * manifest's env still wins over them.
     */
    env?: Record<string, string>;
    /**
     * The transport the plan asks for (ADR-0018, S1). A router decides per
     * task whether the runner can honour it; any other runner ignores it.
     */
    transport?: RunnerTransport;
    /**
     * The runner's own session to continue in (ADR-0018, K1). Only the
     * structured transport can honour it; a terminal session comes back fresh,
     * which is why a continue refuses one.
     */
    resumeSessionId?: string;
    /**
     * Which run of the task this is, from 1. A structured runner binds the
     * attempt's MCP token to it (ADR-0022, A2).
     */
    attempt?: number;
  }): Promise<ITerminalSession>;

  stop(sessionId: string): void;
  stopAll(): void;
  activeCount: number;
}
