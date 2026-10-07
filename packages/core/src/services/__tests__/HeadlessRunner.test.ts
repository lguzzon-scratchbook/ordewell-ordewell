import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { HeadlessRunner, type SpawnFn } from '../HeadlessRunner';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { RunnerPluginManifest } from '../../plugins/types';

function manifest(overrides: Partial<RunnerPluginManifest> = {}): RunnerPluginManifest {
  return {
    name: 'test-runner',
    displayName: 'Test Runner',
    description: 'test',
    version: '1.0.0',
    runner: { command: 'test-cli', argsTemplate: ['{{prompt}}'], promptInArgs: true },
    features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
    modelDiscovery: { method: 'hardcoded', fallbackModels: [] },
    ...overrides,
  };
}

function fakeRegistry(m: RunnerPluginManifest): RunnerRegistry {
  return { get: (id: string) => (id === m.name ? { manifest: m, source: 'builtin' } : undefined) } as unknown as RunnerRegistry;
}

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  // An emitter, as a real pipe is: an `error` on it with no listener throws.
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  killed = false;
  kill = vi.fn((_signal?: string) => { this.killed = true; this.emit('close', 0); return true; });
}

function makeRunner(overrides: { hasScript?: boolean } = {}) {
  const child = new FakeChildProcess();
  const spawnImpl = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
  const runner = new HeadlessRunner({
    spawnImpl,
    hasScriptCmd: () => overrides.hasScript ?? false,
    resolvePath: async () => '/augmented/bin:/usr/bin',
  });
  return { runner, child, spawnImpl: spawnImpl as ReturnType<typeof vi.fn> };
}

/** A runner whose spawns hand out `children` in order. */
function runnerSpawning(...children: FakeChildProcess[]): HeadlessRunner {
  const spawnImpl = children.reduce((fn, child) => fn.mockReturnValueOnce(child), vi.fn()) as unknown as SpawnFn;
  return new HeadlessRunner({ spawnImpl, hasScriptCmd: () => false, resolvePath: async () => '' });
}

const baseOpts = (m: RunnerPluginManifest) => ({
  taskId: 'task-1234-abcd',
  runner: m.name,
  prompt: 'do the thing',
  cwd: '/workspace',
  registry: fakeRegistry(m),
});

describe('HeadlessRunner — stdin', () => {
  const spawnWith = async (m: RunnerPluginManifest, hasScript = false) => {
    const child = new FakeChildProcess();
    const end = child.stdin.end;
    const spawnImpl = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const runner = new HeadlessRunner({ spawnImpl, hasScriptCmd: () => hasScript, resolvePath: async () => '', launchDeps: { platform: 'linux' } });
    await runner.spawn(baseOpts(m));
    return end;
  };

  it('closes stdin on a plain pipe run whose prompt is in its arguments, so a CLI reading stdin to EOF starts', async () => {
    expect(await spawnWith(manifest())).toHaveBeenCalled();
  });

  it('keeps stdin open under a PTY, where it is the terminal', async () => {
    const m = manifest({ runner: { command: 'test-cli', argsTemplate: ['{{prompt}}'], promptInArgs: true, requiresTty: true } });
    expect(await spawnWith(m, true)).not.toHaveBeenCalled();
  });

  it('keeps stdin open when the prompt is not in the arguments', async () => {
    const m = manifest({ runner: { command: 'test-cli', argsTemplate: [], promptInArgs: false } });
    expect(await spawnWith(m)).not.toHaveBeenCalled();
  });
});

describe('HeadlessRunner — versioned command lines', () => {
  const versioned = (): RunnerPluginManifest => manifest({
    runner: {
      command: 'test-cli', argsTemplate: ['old', '{{prompt}}'], promptInArgs: true,
      versioned: [{ minMajor: 2, argsTemplate: ['new', '{{prompt}}'] }],
    },
  });

  it('asks the installed runner its version on the resolved PATH, and launches the shape it takes', async () => {
    const child = new FakeChildProcess();
    const spawnImpl = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const runnerVersion = vi.fn().mockResolvedValue('test-cli v2.3.0');
    const runner = new HeadlessRunner({ spawnImpl, hasScriptCmd: () => false, resolvePath: async () => '/augmented/bin', runnerVersion });

    await runner.spawn(baseOpts(versioned()));

    expect(runnerVersion).toHaveBeenCalledWith('test-cli', '/augmented/bin');
    expect((spawnImpl as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(['new', 'do the thing']);
  });

  it('keeps the base shape when the version cannot be read', async () => {
    const child = new FakeChildProcess();
    const spawnImpl = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const runner = new HeadlessRunner({ spawnImpl, hasScriptCmd: () => false, resolvePath: async () => '', runnerVersion: async () => undefined });

    await runner.spawn(baseOpts(versioned()));

    expect((spawnImpl as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(['old', 'do the thing']);
  });

  it('never asks a runner whose manifest has one shape', async () => {
    const child = new FakeChildProcess();
    const spawnImpl = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const runnerVersion = vi.fn();
    const runner = new HeadlessRunner({ spawnImpl, hasScriptCmd: () => false, resolvePath: async () => '', runnerVersion });

    await runner.spawn(baseOpts(manifest()));

    expect(runnerVersion).not.toHaveBeenCalled();
  });
});

describe('HeadlessRunner', () => {
  it('spawns the resolved invocation with cwd and augmented PATH', async () => {
    const m = manifest();
    const { runner, spawnImpl } = makeRunner();

    await runner.spawn(baseOpts(m));

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnImpl.mock.calls[0];
    expect(command).toBe('test-cli');
    expect(args).toEqual(['do the thing']);
    expect(options.cwd).toBe('/workspace');
    expect(options.env.PATH).toBe('/augmented/bin:/usr/bin');
  });

  it("adds the workspace's variables under the manifest's own, which win", async () => {
    const m = manifest({ runner: { command: 'test-cli', argsTemplate: ['{{prompt}}'], promptInArgs: true, env: { SHARED: 'manifest' } } });
    const { runner, spawnImpl } = makeRunner();

    await runner.spawn({ ...baseOpts(m), env: { CLAUDE_CONFIG_DIR: '/home/me/.claude-work', SHARED: 'workspace' } });

    const { env } = spawnImpl.mock.calls[0][2];
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/me/.claude-work');
    expect(env.SHARED).toBe('manifest');
  });

  it('wraps in a PTY via script when the manifest requires a TTY and script exists', async () => {
    const m = manifest({ runner: { command: 'test-cli', argsTemplate: ['{{prompt}}'], promptInArgs: true, requiresTty: true } });
    const child = new FakeChildProcess();
    const spawnImpl = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const runner = new HeadlessRunner({ spawnImpl, hasScriptCmd: () => true, resolvePath: async () => '', launchDeps: { platform: 'linux' } });

    await runner.spawn(baseOpts(m));

    const [command, args] = (spawnImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(command).toBe('script');
    expect(args).toEqual(['-q', '-e', '-f', '-c', `'test-cli' 'do the thing'`, '/dev/null']);
  });

  it('spawns directly when the manifest requires a TTY but script is unavailable', async () => {
    const m = manifest({ runner: { command: 'test-cli', argsTemplate: ['{{prompt}}'], promptInArgs: true, requiresTty: true } });
    const { runner, spawnImpl } = makeRunner({ hasScript: false });

    await runner.spawn(baseOpts(m));

    expect(spawnImpl.mock.calls[0][0]).toBe('test-cli');
  });

  it('throws on an unknown runner id', async () => {
    const { runner } = makeRunner();
    await expect(
      runner.spawn({ ...baseOpts(manifest()), runner: 'nope' }),
    ).rejects.toThrow(/Unknown runner: nope/);
  });

  it('marks a piped session non-interactive so resume tokens use a newline', async () => {
    const session = await makeRunner().runner.spawn(baseOpts(manifest()));
    expect(session.interactive).toBe(false);
  });

  it('emits raw output but buffers it ANSI-stripped', async () => {
    const m = manifest();
    const { runner, child } = makeRunner();
    const session = await runner.spawn(baseOpts(m));

    const emitted: string[] = [];
    session.onOutput((text) => emitted.push(text));
    child.stdout.emit('data', Buffer.from('\x1b[31mred\x1b[0m line\r\n'));
    child.stderr.emit('data', Buffer.from('warn\r'));

    expect(emitted).toEqual(['\x1b[31mred\x1b[0m line\r\n', 'warn\r']);
    expect(session.getOutput()).toBe('red line\nwarn');
  });

  it('fires onExit with the close code and unregisters the session', async () => {
    const m = manifest();
    const { runner, child } = makeRunner();
    const session = await runner.spawn(baseOpts(m));
    expect(runner.activeCount).toBe(1);

    const exit = vi.fn();
    session.onExit(exit);
    child.emit('close', 3);

    expect(exit).toHaveBeenCalledWith(3);
    expect(runner.activeCount).toBe(0);
  });

  it('reports a spawn error as output and exit -1', async () => {
    const m = manifest();
    const { runner, child } = makeRunner();
    const session = await runner.spawn(baseOpts(m));

    const exit = vi.fn();
    session.onExit(exit);
    child.emit('error', new Error('ENOENT'));

    expect(session.getOutput()).toContain('Process error: ENOENT');
    expect(exit).toHaveBeenCalledWith(-1);
  });

  it('stop(sessionId) kills the underlying process', async () => {
    const m = manifest();
    const { runner, child } = makeRunner();
    const session = await runner.spawn(baseOpts(m));

    runner.stop(session.id);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(runner.activeCount).toBe(0);
  });

  it('stopAll kills every active session', async () => {
    const m = manifest();
    const child1 = new FakeChildProcess();
    const child2 = new FakeChildProcess();
    const runner = runnerSpawning(child1, child2);

    await runner.spawn(baseOpts(m));
    await runner.spawn({ ...baseOpts(m), taskId: 'task-5678-efgh' });

    runner.stopAll();
    expect(child1.kill).toHaveBeenCalled();
    expect(child2.kill).toHaveBeenCalled();
    expect(runner.activeCount).toBe(0);
  });

  // A retry respawns the same task id, and task ids often share a prefix
  // ("task-1234-abcd" / "task-1234-wxyz"), so the old attempt's late exit used
  // to unregister the new attempt under the shared key.
  it('keeps a retry registered when the previous attempt of the same task exits', async () => {
    const m = manifest();
    const child1 = new FakeChildProcess();
    const child2 = new FakeChildProcess();
    const runner = runnerSpawning(child1, child2);

    const first = await runner.spawn(baseOpts(m));
    const retry = await runner.spawn(baseOpts(m));
    child1.emit('close', 1);

    expect(retry.id).not.toBe(first.id);
    expect(runner.activeCount).toBe(1);
    runner.stop(retry.id);
    expect(child2.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('gives tasks that share an 8-character id prefix distinct sessions', async () => {
    const m = manifest();
    const child1 = new FakeChildProcess();
    const child2 = new FakeChildProcess();
    const runner = runnerSpawning(child1, child2);

    const a = await runner.spawn({ ...baseOpts(m), taskId: 'task-1234-abcd' });
    const b = await runner.spawn({ ...baseOpts(m), taskId: 'task-1234-wxyz' });

    expect(a.id).not.toBe(b.id);
    expect(runner.activeCount).toBe(2);
    runner.stop(a.id);
    expect(child1.kill).toHaveBeenCalled();
    expect(child2.kill).not.toHaveBeenCalled();
  });

  it('forwards write() to the child stdin', async () => {
    const m = manifest();
    const { runner, child } = makeRunner();
    const session = await runner.spawn(baseOpts(m));

    session.write('y\n');
    expect(child.stdin.write).toHaveBeenCalledWith('y\n');
  });
});

describe('HeadlessRunner — the runner process', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  // The run's own exit (a PTY run's submit Enter, a user reply) can race the
  // child's death; the asynchronous EPIPE that follows used to crash the host.
  it('survives a write to a runner that already exited', async () => {
    const { runner, child } = makeRunner();
    const session = await runner.spawn(baseOpts(manifest()));
    session.write('a reply\r');
    expect(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
  });

  it("leaves the host's nesting and debugging variables behind, keeping one the workspace sets", async () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('NODE_INSPECT', '1');
    vi.stubEnv('NODE_DEBUG', 'net');
    vi.stubEnv('NODE_OPTIONS', '--inspect');
    vi.stubEnv('ORDEWELL_TEST_KEPT', 'yes');
    const { runner, spawnImpl } = makeRunner();

    await runner.spawn({ ...baseOpts(manifest()), env: { NODE_OPTIONS: '--max-old-space-size=8192' } });

    const { env } = spawnImpl.mock.calls[0][2];
    for (const name of ['CLAUDECODE', 'NODE_INSPECT', 'NODE_DEBUG']) expect(env).not.toHaveProperty(name);
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=8192');
    expect(env.ORDEWELL_TEST_KEPT).toBe('yes');
  });

  it('keeps a multibyte character whole when a read splits it', async () => {
    const { runner, child } = makeRunner();
    const session = await runner.spawn(baseOpts(manifest()));
    const seen: string[] = [];
    session.onOutput((text) => seen.push(text));

    const bytes = Buffer.from('déjà 日本\n');
    child.stdout.emit('data', bytes.subarray(0, 2));
    child.stdout.emit('data', bytes.subarray(2, 9));
    child.stdout.emit('data', bytes.subarray(9));

    expect(seen.join('')).toBe('déjà 日本\n');
    expect(session.getOutput()).toBe('déjà 日本\n');
  });

  it('starts the runner as the leader of its own process group, so Stop reaches what it starts', async () => {
    const spawnImpl = vi.fn().mockReturnValue(new FakeChildProcess());
    const runner = new HeadlessRunner({ spawnImpl: spawnImpl as unknown as SpawnFn, hasScriptCmd: () => false, resolvePath: async () => '', launchDeps: { platform: 'linux' } });
    await runner.spawn(baseOpts(manifest()));
    expect(spawnImpl.mock.calls[0][2].detached).toBe(true);
  });
});

/**
 * The Windows launch route. `spawn` with `shell: false` is CreateProcess, which
 * performs no PATHEXT lookup — so the bare `test-cli` the invocation names was
 * ENOENT on Windows no matter how the user installed it.
 */
describe('HeadlessRunner on Windows', () => {
  function winRunner(files: string[]) {
    const child = new FakeChildProcess();
    const spawnImpl = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const present = new Set(files.map((f) => f.toLowerCase()));
    const runner = new HeadlessRunner({
      spawnImpl,
      hasScriptCmd: () => false,
      resolvePath: async () => 'C:\\tools',
      launchDeps: {
        platform: 'win32',
        exists: (c) => present.has(c.toLowerCase()),
        comSpec: () => 'C:\\Windows\\System32\\cmd.exe',
        pathExt: () => '.EXE;.CMD',
      },
    });
    return { runner, spawnImpl: spawnImpl as ReturnType<typeof vi.fn> };
  }

  it('spawns the resolved executable rather than the bare command name', async () => {
    const m = manifest();
    const { runner, spawnImpl } = winRunner(['C:\\tools\\test-cli.exe']);

    await runner.spawn(baseOpts(m));

    const [command, , options] = spawnImpl.mock.calls[0];
    expect(command).toBe('C:\\tools\\test-cli.exe');
    expect(options.windowsVerbatimArguments).toBeUndefined();
    // A detached process on Windows gets a console of its own; taskkill /T already reaches the tree.
    expect(options.detached).toBeFalsy();
  });

  it('routes a batch shim through cmd.exe with verbatim arguments', async () => {
    const m = manifest();
    const { runner, spawnImpl } = winRunner(['C:\\tools\\test-cli.cmd']);

    await runner.spawn(baseOpts(m));

    const [command, args, options] = spawnImpl.mock.calls[0];
    expect(command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    // Without the flag, Node would re-quote an already-quoted command line.
    expect(options.windowsVerbatimArguments).toBe(true);
  });

  // A `script`-wrapped invocation is POSIX-only and would be unresolvable here.
  it('never wraps in script, because hasScriptCmd is false on Windows', async () => {
    const m = manifest({ runner: { command: 'test-cli', argsTemplate: ['{{prompt}}'], promptInArgs: true, requiresTty: true } });
    const { runner, spawnImpl } = winRunner(['C:\\tools\\test-cli.exe']);

    await runner.spawn(baseOpts(m));

    expect(spawnImpl.mock.calls[0][0]).toBe('C:\\tools\\test-cli.exe');
  });

  it('hands the child exactly one PATH-ish key', async () => {
    const m = manifest();
    const { runner, spawnImpl } = winRunner(['C:\\tools\\test-cli.exe']);

    await runner.spawn(baseOpts(m));

    const env = spawnImpl.mock.calls[0][2].env as Record<string, string>;
    const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
    expect(pathKeys).toHaveLength(1);
    expect(env[pathKeys[0]]).toBe('C:\\tools');
  });
});
