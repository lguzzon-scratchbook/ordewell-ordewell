import { execFile } from 'child_process';
import type { ChildProcess } from 'child_process';

/**
 * Stopping an agent process, on every platform.
 *
 * POSIX gets SIGTERM, then SIGKILL after a grace period — sent to the runner's
 * whole process group when it was started by {@link spawnInOwnGroup}, because
 * the direct child is a CLI and what kept running after Stop was everything it
 * had started: shells, MCP servers, test runs, dev servers. Windows has no signals — `ChildProcess.kill` calls TerminateProcess
 * on the direct child only — and on Windows the direct child is frequently not
 * the agent. A `claude.cmd` shim launched through cmd.exe puts an interpreter
 * between Ordewell and the `node cli.js` doing the work, so terminating the child
 * left the real agent running: still holding the workspace, still spending the
 * user's subscription, invisible to the surface that thought it had stopped.
 * `taskkill /T` walks the tree instead.
 *
 * Both paths are best-effort and idempotent by construction. A process that has
 * already exited is not an error here — every caller is on a dispose path.
 */

/** Grace period between the polite stop and the forced one. */
const HARD_KILL_DELAY_MS = 5000;

export interface KillTreeDeps {
  platform?: NodeJS.Platform;
  /** Runs `taskkill`. Injected so the Windows path is testable off Windows. */
  execFileImpl?: (file: string, args: string[], cb: (err: Error | null) => void) => void;
  /** Schedules the forced kill. Injected so tests need no timers. */
  setTimeoutImpl?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimeoutImpl?: (handle: unknown) => void;
  /** Signals a pid, or a process group as its negated id. Injected so the group path needs no real processes. */
  killImpl?: (pid: number, signal: NodeJS.Signals) => void;
}

/** Processes {@link spawnInOwnGroup} made group leaders. */
const groupLeaders = new WeakSet<ChildProcess>();
/** Leaders already signalled: a group signal leaves `proc.killed` false, so it cannot say. */
const stopping = new WeakSet<ChildProcess>();
/**
 * Groups led by a live runner, by id. Dropped when the leader exits: past that
 * point the id is no longer evidence the group is ours.
 */
const ownGroups = new Map<number, ChildProcess>();
let hostTeardownHooked = false;

/**
 * Start a runner as the leader of a new process group, so {@link killTree}
 * reaches everything it starts. `spawn` is handed the `detached` flag to pass
 * to Node, which on POSIX is what makes a child a group (and session) leader.
 * Stdio pipes and the host's event loop are unaffected; only `unref` changes
 * the latter, and nothing here calls it.
 *
 * Not on Windows: there `detached` gives the child a console of its own, and
 * `taskkill /T` already walks the tree.
 */
export function spawnInOwnGroup(spawn: (detached: boolean) => ChildProcess, platform: NodeJS.Platform = process.platform): ChildProcess {
  if (platform === 'win32') return spawn(false);
  const proc = spawn(true);
  const pgid = proc.pid;
  // No pid: the spawn failed, and its 'error' event reports that.
  if (typeof pgid !== 'number') return proc;
  groupLeaders.add(proc);
  ownGroups.set(pgid, proc);
  proc.once('exit', () => ownGroups.delete(pgid));
  hookHostTeardown();
  return proc;
}

/**
 * A detached runner has left the terminal's foreground group, so Ctrl-C (or a
 * closed terminal) no longer reaches it — the host has to pass that on to the
 * groups it leads. Polite only, and not again to a group already asked: a
 * host disposing its sessions on the way out has just sent SIGTERM, and a
 * second one reads to some CLIs as "quit without cleaning up".
 */
function hookHostTeardown(): void {
  if (hostTeardownHooked) return;
  hostTeardownHooked = true;
  const stopAll = () => {
    for (const [pgid, leader] of ownGroups) {
      if (stopping.has(leader)) continue;
      try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
    }
    ownGroups.clear();
  };
  process.on('exit', stopAll);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const onSignal = () => {
      stopAll();
      // A host with a handler of its own decides how to exit. One without was
      // relying on the default, which listening has replaced, so this listener
      // steps aside and the signal is raised again to end the host as before.
      if (process.listenerCount(signal) > 1) return;
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

function defaultExecFile(file: string, args: string[], cb: (err: Error | null) => void): void {
  execFile(file, args, (err) => cb(err ?? null));
}

/**
 * Terminate `proc` and everything it started.
 *
 * Returns immediately; the forced follow-up (SIGKILL, or `taskkill /F`) is
 * scheduled and unref'd, so a disposed session is never the reason the host
 * process refuses to exit.
 */
export function killTree(proc: ChildProcess | null, deps: KillTreeDeps = {}): void {
  // `typeof … === 'number'`, not `!== null`: only a numeric exit code is
  // positive evidence the process is gone. A running child reports null, and an
  // object that reports neither is treated as running — the cost of a redundant
  // kill is nothing, the cost of skipping a live one is an orphaned agent.
  if (!proc || proc.killed || typeof proc.exitCode === 'number') return;

  const platform = deps.platform ?? process.platform;
  const setTimeoutImpl = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms) as unknown as { unref?: () => void });
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? ((h) => clearTimeout(h as NodeJS.Timeout));

  if (platform === 'win32') {
    // No pid means the process never started; there is no tree to walk.
    if (typeof proc.pid !== 'number') return;
    const pid = proc.pid;
    const run = deps.execFileImpl ?? defaultExecFile;

    // `/T` is the whole point: without it this is the TerminateProcess call
    // that already failed to reach the agent. The unforced pass first gives a
    // console app a chance to flush; `/F` follows if it did not take.
    run('taskkill', ['/pid', String(pid), '/T'], () => { /* exit code is not news */ });
    const hardKill = setTimeoutImpl(() => {
      run('taskkill', ['/pid', String(pid), '/T', '/F'], () => { /* already gone */ });
    }, HARD_KILL_DELAY_MS);
    hardKill.unref?.();
    proc.once('exit', () => clearTimeoutImpl(hardKill));
    return;
  }

  if (groupLeaders.has(proc) && typeof proc.pid === 'number') {
    if (stopping.has(proc)) return;
    stopping.add(proc);
    const pgid = proc.pid;
    const killImpl = deps.killImpl ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); });
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        killImpl(-pgid, signal);
      } catch {
        try { proc.kill(signal); } catch { /* already gone */ }
      }
    };
    signalGroup('SIGTERM');
    // Not cancelled when the leader exits: what it started can outlive it,
    // and a process ignoring SIGTERM is exactly the one that does.
    const hardKill = setTimeoutImpl(() => signalGroup('SIGKILL'), HARD_KILL_DELAY_MS);
    hardKill.unref?.();
    return;
  }

  try {
    proc.kill('SIGTERM');
    const hardKill = setTimeoutImpl(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }, HARD_KILL_DELAY_MS);
    hardKill.unref?.();
    proc.once('exit', () => clearTimeoutImpl(hardKill));
  } catch {
    // Process already gone — nothing to clean up.
  }
}
