import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ChildProcess } from 'child_process';
import type { SpawnFn } from '../HeadlessRunner';
import type { AgentAdapterFactory, AgentEvent } from '../harness/AgentAdapter';

/**
 * The one test seam for harness planners (ADR-0009): a fake process boundary,
 * injected the way `HeadlessRunnerDeps` injects its `spawnImpl`.
 *
 * Driving the service through this exercises adapter parsing, event mapping,
 * reply classification and the repair loop as a single observable behavior —
 * which is the point. The adapters are not separately mocked; the service
 * tests are what prove each one satisfies the interface.
 */

export interface FakeAgentProcess extends ChildProcess {
  /** Everything the adapter wrote to stdin, one entry per write. */
  readonly written: string[];
  /** Whether the adapter closed stdin — what makes a real CLI waiting for input exit. */
  readonly stdinEnded: boolean;
  /** Push a chunk onto the fake stdout, as the real CLI would. */
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
  /** End the process, as a crash or a normal exit. */
  exit(code: number, signal?: string): void;
}

/**
 * Replies to each write with the next scripted response. A response is either
 * raw text pushed to stdout, or a function for the cases that need to look at
 * what was written (a resume flag, a corrective re-emit) or to kill the
 * process mid-turn.
 */
export type ScriptedReply = string | ((written: string, proc: FakeAgentProcess) => void);

export interface FakeSpawnResult {
  spawn: SpawnFn;
  /** Every process the code under test spawned, in order. Probes excluded. */
  readonly processes: FakeAgentProcess[];
  /** The argv of the most recent spawn — how the read-only flags are asserted. */
  lastArgs(): string[];
  lastCommand(): string;
  /** The argv of each sandbox probe, in order — see {@link FakeSpawnOptions.probe}. */
  probeArgs(): string[][];
}

export interface FakeSpawnOptions {
  /**
   * Answers the sandbox capability probe Codex runs before its handshake
   * (`codex sandbox … /bin/true`). Given the probe's argv, return the exit code
   * and anything it printed. The default is a machine whose sandbox works, so
   * scenarios that are not about the sandbox never mention it.
   */
  probe?: (args: string[]) => { code: number; output?: string };
}

function makeProcess(): FakeAgentProcess {
  const proc = new EventEmitter() as unknown as FakeAgentProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const written: string[] = [];
  let killed = false;
  let stdinEnded = false;

  Object.defineProperties(proc, {
    stdout: { value: stdout, writable: false },
    stderr: { value: stderr, writable: false },
    written: { get: () => written },
    killed: { get: () => killed },
    stdinEnded: { get: () => stdinEnded },
    // An emitter, as a real pipe is: an `error` on it with no listener throws.
    stdin: {
      value: Object.assign(new EventEmitter(), {
        write(chunk: string) {
          written.push(chunk);
          // Deliver asynchronously: a real CLI never answers inside the same
          // tick as the write, and a synchronous answer would let a test pass
          // against code that races the listener registration.
          queueMicrotask(() => proc.emit('__written', chunk));
          return true;
        },
        end() { stdinEnded = true; },
      }),
      writable: false,
    },
    kill: {
      value: (signal?: string) => {
        if (killed) return false;
        killed = true;
        queueMicrotask(() => proc.emit('exit', null, signal ?? 'SIGTERM'));
        return true;
      },
      writable: false,
    },
    emitStdout: { value: (chunk: string) => stdout.emit('data', Buffer.from(chunk)), writable: false },
    emitStderr: { value: (chunk: string) => stderr.emit('data', Buffer.from(chunk)), writable: false },
    exit: {
      value: (code: number, signal?: string) => { killed = true; proc.emit('exit', code, signal ?? null); },
      writable: false,
    },
  });

  // A never-listened-to 'error' on an EventEmitter throws; adapters attach one,
  // but a test that never sends a turn would otherwise be fragile.
  proc.on('error', () => { /* observed by the adapter */ });
  return proc;
}

/**
 * A fake spawn whose process answers each stdin write with the next scripted
 * reply. Unscripted writes are ignored, which is how "the agent never
 * answered" is tested.
 *
 * One reply is consumed per *write*, not per turn — and adapters write on the
 * control channel too (a Claude Code permission denial, a Codex JSON-RPC
 * response). A scenario that answers a request mid-turn must either account for
 * those writes or use a function reply that inspects `written` and only answers
 * the user turns.
 */
export function fakeSpawn(replies: ScriptedReply[], options: FakeSpawnOptions = {}): FakeSpawnResult {
  const processes: FakeAgentProcess[] = [];
  const probes: string[][] = [];
  let command = '';
  let args: string[] = [];
  const queue = [...replies];

  const spawn: SpawnFn = (cmd, argv) => {
    // The sandbox probe is a short-lived side process, not the agent's
    // transport: it is kept out of `processes` and `lastArgs` so that adding it
    // does not shift the indices every other scenario asserts on.
    if (argv[0] === 'sandbox') {
      const proc = makeProcess();
      probes.push(argv);
      const { code, output } = options.probe?.(argv) ?? { code: 0 };
      queueMicrotask(() => {
        if (output) proc.emitStderr(output);
        proc.exit(code);
      });
      return proc as unknown as ChildProcess;
    }

    command = cmd;
    args = argv;
    const proc = makeProcess();
    processes.push(proc);
    proc.on('__written', (chunk: string) => {
      const reply = queue.shift();
      if (reply === undefined) return;
      if (typeof reply === 'function') reply(chunk, proc);
      else proc.emitStdout(reply);
    });
    return proc as unknown as ChildProcess;
  };

  return {
    spawn,
    processes,
    lastArgs: () => args,
    lastCommand: () => command,
    probeArgs: () => probes,
  };
}

/**
 * A fake spawn whose every process hands each stdin write to `onWrite`, with
 * the argv it was spawned under — for an agent that must answer the control
 * channel and the turns alike, however many of each a scenario sends.
 */
export function respondingSpawn(onWrite: (written: string, proc: FakeAgentProcess, args: string[]) => void): FakeSpawnResult {
  const processes: FakeAgentProcess[] = [];
  let command = '';
  let args: string[] = [];
  const spawn: SpawnFn = (cmd, argv) => {
    command = cmd;
    args = argv;
    const proc = makeProcess();
    processes.push(proc);
    proc.on('__written', (chunk: string) => onWrite(chunk, proc, argv));
    return proc as unknown as ChildProcess;
  };
  return { spawn, processes, lastArgs: () => args, lastCommand: () => command, probeArgs: () => [] };
}

/**
 * Read a recorded agent transcript. One fixture per agent per scenario;
 * re-recording one against a newer CLI is how schema drift becomes a
 * reviewable diff.
 *
 * `{{PLAN}}` is substituted with a JSON-escaped plan body rather than being
 * baked into the fixture. A plan object escaped inside a JSON string inside a
 * JSONL line is unreadable, and would silently rot the day the validator's
 * required fields change — the transport shape is what these fixtures are for.
 */
export function fixture(agent: string, name: string, vars: Record<string, string> = {}): string {
  const raw = readFileSync(join(__dirname, 'fixtures', 'harness', agent, `${name}.jsonl`), 'utf8');
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.split(`{{${key}}}`).join(JSON.stringify(value).slice(1, -1)),
    raw,
  );
}

/** A plan the validator accepts, as the JSON object an agent would emit. */
export function planJson(runner = 'claude-code'): string {
  return JSON.stringify({
    tasks: [
      {
        id: 'task-1',
        order: 1,
        title: 'Add the thing',
        description: 'Adds the thing',
        type: 'ai',
        dependencies: [],
        prompt: 'Add the thing to src/thing.ts',
        assignedRunner: runner,
        assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet' },
        taskMode: 'acceptEdits',
        autonomy: 'AFK',
        sliceType: 'AFK',
        subtasks: [],
      },
    ],
  });
}

/**
 * An adapter that plays one scripted event list per `send`, for the service's
 * own mapping rules — the events no recorded transcript produces yet, or
 * orderings a fixture would bury. Adapters themselves are proven through
 * {@link fakeSpawn}; this skips them on purpose.
 */
export function scriptedAdapter(turns: AgentEvent[][], agentId = 'claude-code'): AgentAdapterFactory {
  const queue = [...turns];
  return () => ({
    agentId,
    start: async () => {},
    send: async (_message, onEvent) => {
      for (const event of queue.shift() ?? [{ type: 'turn_end' }]) onEvent(event);
    },
    nativeSessionId: () => null,
    dispose: () => {},
  });
}

/**
 * One recorded OpenCode turn. OpenCode answers over HTTP rather than stdio, so
 * a turn is two recordings, not one transcript: the `/event` frames the server
 * pushed while the turn ran, and the settled response to the message POST.
 * Frames come back SSE-encoded, ready to hand to a fake `/event` body.
 */
export function openCodeFixture(name: string): { sessionId: string; frames: string[]; response: { info: { id: string; sessionID: string } } } {
  const dir = join(__dirname, 'fixtures', 'harness', 'opencode');
  const response = JSON.parse(readFileSync(join(dir, `${name}.response.json`), 'utf8')) as { info: { id: string; sessionID: string } };
  const frames = readFileSync(join(dir, `${name}.events.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => `data: ${line}\n\n`);
  return { sessionId: response.info.sessionID, frames, response };
}
