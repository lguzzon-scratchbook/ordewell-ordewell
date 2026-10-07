import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { killTree, spawnInOwnGroup, type KillTreeDeps } from '../processTree';

class FakeChild extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  pid: number | undefined = 4242;
  kill = vi.fn((_signal?: NodeJS.Signals) => { this.killed = true; return true; });
}

/** Captures the scheduled hard kill so a test can fire it without timers. */
function harness(overrides: Partial<KillTreeDeps> = {}) {
  const child = new FakeChild();
  const taskkill = vi.fn((_f: string, _a: string[], cb: (e: Error | null) => void) => cb(null));
  let scheduled: (() => void) | null = null;
  const deps: KillTreeDeps = {
    execFileImpl: taskkill,
    setTimeoutImpl: (fn) => { scheduled = fn; return { unref: () => {} }; },
    clearTimeoutImpl: () => { scheduled = null; },
    ...overrides,
  };
  return {
    child, taskkill, deps,
    fireHardKill: () => scheduled?.(),
    isScheduled: () => scheduled !== null,
  };
}

describe('killTree on POSIX', () => {
  it('sends SIGTERM immediately and escalates to SIGKILL on the grace timer', () => {
    const h = harness({ platform: 'linux' });
    killTree(h.child as unknown as ChildProcess, h.deps);

    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(h.child.kill).toHaveBeenCalledTimes(1);

    h.fireHardKill();
    expect(h.child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('cancels the escalation when the process exits on its own', () => {
    const h = harness({ platform: 'linux' });
    killTree(h.child as unknown as ChildProcess, h.deps);

    h.child.emit('exit');
    expect(h.isScheduled()).toBe(false);
  });

  it('never reaches for taskkill', () => {
    const h = harness({ platform: 'darwin' });
    killTree(h.child as unknown as ChildProcess, h.deps);
    h.fireHardKill();
    expect(h.taskkill).not.toHaveBeenCalled();
  });
});

describe('killTree on Windows', () => {
  // `/T` is the whole point. Windows has no signals, so ChildProcess.kill
  // terminates only the direct child — which for a `.cmd` shim is cmd.exe, not
  // the agent. The agent survived, still holding the workspace and the
  // subscription, invisible to the surface that thought it had stopped.
  it('walks the process tree instead of terminating only the direct child', () => {
    const h = harness({ platform: 'win32' });
    killTree(h.child as unknown as ChildProcess, h.deps);

    expect(h.taskkill).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/T'], expect.any(Function));
    expect(h.child.kill).not.toHaveBeenCalled();
  });

  it('escalates to a forced tree kill on the grace timer', () => {
    const h = harness({ platform: 'win32' });
    killTree(h.child as unknown as ChildProcess, h.deps);
    h.fireHardKill();

    expect(h.taskkill).toHaveBeenLastCalledWith('taskkill', ['/pid', '4242', '/T', '/F'], expect.any(Function));
  });

  it('does nothing for a process that never started, since there is no tree', () => {
    const h = harness({ platform: 'win32' });
    h.child.pid = undefined;
    killTree(h.child as unknown as ChildProcess, h.deps);
    expect(h.taskkill).not.toHaveBeenCalled();
  });

  it('ignores taskkill failure — every caller is on a dispose path', () => {
    const h = harness({
      platform: 'win32',
      execFileImpl: (_f, _a, cb) => cb(new Error('not found')),
    });
    expect(() => killTree(h.child as unknown as ChildProcess, h.deps)).not.toThrow();
  });
});

describe('killTree guards', () => {
  it('is a no-op for a null process', () => {
    const h = harness({ platform: 'linux' });
    expect(() => killTree(null, h.deps)).not.toThrow();
  });

  it('skips a process that already reported an exit code', () => {
    const h = harness({ platform: 'linux' });
    h.child.exitCode = 0;
    killTree(h.child as unknown as ChildProcess, h.deps);
    expect(h.child.kill).not.toHaveBeenCalled();
  });

  // Only a numeric exit code is evidence the process is gone. A test double or
  // a partially-initialised handle reports neither, and skipping a live process
  // costs an orphaned agent while a redundant kill costs nothing.
  it('treats an unknown exit code as still running', () => {
    const h = harness({ platform: 'linux' });
    (h.child as { exitCode: number | null | undefined }).exitCode = undefined;
    killTree(h.child as unknown as ChildProcess, h.deps);
    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('is idempotent — a second call after killed does nothing', () => {
    const h = harness({ platform: 'linux' });
    killTree(h.child as unknown as ChildProcess, h.deps);
    killTree(h.child as unknown as ChildProcess, h.deps);
    expect(h.child.kill).toHaveBeenCalledTimes(1);
  });
});

/** A pid no real process group can have, so a stray signal reaches nothing. */
const UNUSED_PID = 2 ** 31 - 2;

describe('killTree on a runner that leads its own process group', () => {
  function leader() {
    const child = new FakeChild();
    child.pid = UNUSED_PID;
    const spawn = vi.fn((_detached: boolean) => child as unknown as ChildProcess);
    spawnInOwnGroup(spawn, 'linux');
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const h = harness({ platform: 'linux', killImpl: (pid, signal) => { signals.push([pid, signal]); } });
    return { child, spawn, signals, h };
  }

  it('is spawned detached, which on POSIX makes it the leader of a new group', () => {
    const { spawn, child } = leader();
    expect(spawn).toHaveBeenCalledWith(true);
    child.emit('exit', 0);
  });

  it('is not detached on Windows, where that opens a console and taskkill /T already walks the tree', () => {
    const spawn = vi.fn((_detached: boolean) => new FakeChild() as unknown as ChildProcess);
    spawnInOwnGroup(spawn, 'win32');
    expect(spawn).toHaveBeenCalledWith(false);
  });

  // The direct child is a CLI; the shells, MCP servers, test runs and dev
  // servers it started are what kept running after Stop.
  it('signals the whole group, not just the direct child', () => {
    const { child, signals, h } = leader();
    killTree(child as unknown as ChildProcess, h.deps);

    expect(signals).toEqual([[-UNUSED_PID, 'SIGTERM']]);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('exit', null, 'SIGTERM');
  });

  it('still escalates to SIGKILL after the leader exits, since what it started can outlive it', () => {
    const { child, signals, h } = leader();
    killTree(child as unknown as ChildProcess, h.deps);
    child.emit('exit', null, 'SIGTERM');

    expect(h.isScheduled()).toBe(true);
    h.fireHardKill();
    expect(signals).toEqual([[-UNUSED_PID, 'SIGTERM'], [-UNUSED_PID, 'SIGKILL']]);
  });

  it('falls back to the direct child when the group cannot be signalled', () => {
    const { child } = leader();
    const h = harness({ platform: 'linux', killImpl: () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); } });
    killTree(child as unknown as ChildProcess, h.deps);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', null, 'SIGTERM');
  });

  it('is idempotent — a second stop sends nothing more', () => {
    const { child, signals, h } = leader();
    killTree(child as unknown as ChildProcess, h.deps);
    killTree(child as unknown as ChildProcess, h.deps);

    expect(signals).toHaveLength(1);
    child.emit('exit', null, 'SIGTERM');
  });
});

const posixIt = it.skipIf(process.platform === 'win32');

/** Polls until `pid` no longer exists. */
async function gone(pid: number, withinMs = 3000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** The first line `proc` prints, as a pid. */
function firstPid(proc: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let out = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const newline = out.indexOf('\n');
      if (newline >= 0) resolve(Number(out.slice(0, newline)));
    });
    proc.once('exit', () => reject(new Error(`exited before printing a pid: ${out}`)));
  });
}

/** A shell that backgrounds a long sleep — the grandchild Stop used to miss — and prints its pid. */
const SHELL_WITH_GRANDCHILD = ['-c', 'sleep 30 & echo $!; wait'];

describe('process groups, for real', () => {
  posixIt('Stop reaches a grandchild the runner started, and stdout still pipes', async () => {
    const proc = spawnInOwnGroup((detached) => spawn('sh', SHELL_WITH_GRANDCHILD, { detached, stdio: ['pipe', 'pipe', 'pipe'] }));
    const grandchild = await firstPid(proc);
    try {
      killTree(proc);
      expect(await gone(grandchild)).toBe(true);
    } finally {
      try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone, as it should be */ }
    }
  });

  // Ctrl-C reaches the terminal's foreground group, which a detached runner
  // has left — so the host has to pass the signal on to the groups it leads.
  posixIt.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('a host killed by %s takes its runners\' groups with it', async (signal) => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-host-'));
    const host = join(dir, 'host.mts');
    writeFileSync(host, [
      `import { spawn } from 'node:child_process';`,
      `import { spawnInOwnGroup } from ${JSON.stringify(join(__dirname, '..', 'processTree.ts'))};`,
      `const proc = spawnInOwnGroup((detached) => spawn('sh', ${JSON.stringify(SHELL_WITH_GRANDCHILD)}, { detached, stdio: ['ignore', 'pipe', 'inherit'] }));`,
      `proc.stdout.pipe(process.stdout);`,
    ].join('\n'));
    const hostProc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', host], { stdio: ['ignore', 'pipe', 'pipe'] });
    let grandchild = 0;
    try {
      grandchild = await firstPid(hostProc);
      const exited = new Promise<NodeJS.Signals | null>((resolve) => hostProc.once('exit', (_code, sig) => resolve(sig)));
      hostProc.kill(signal);
      expect(await exited).toBe(signal);
      expect(await gone(grandchild)).toBe(true);
    } finally {
      hostProc.kill('SIGKILL');
      if (grandchild) try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone, as it should be */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
