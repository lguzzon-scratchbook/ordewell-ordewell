import { execFile } from 'child_process';
import { promisify } from 'util';
import { withPath } from '../utils/shellPath';

export type GitExecFn = (
  file: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface GitResult { ok: boolean; stdout: string; stderr: string; code?: string | number }

/** What every git call goes through: the process seam and the PATH it runs with. */
export interface GitInvoker {
  exec: GitExecFn;
  resolvePath: () => Promise<string>;
}

const execFileAsync = promisify(execFile);

// Generous on purpose: `reviewDiff` returns the whole run's diff in one buffer.
export const MAX_BUFFER = 64 * 1024 * 1024;

// Landings wait on each other, so one git call that never returns — a commit
// hook waiting on input, a GPG pinentry nobody will see — would stall every
// landing after it. Generous, since a commit hook may run a whole test suite.
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

export const defaultExecFile: GitExecFn = async (file, args, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      maxBuffer: MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      // A hook can trap SIGTERM.
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    if (!timedOut(err)) throw err;
    const stderr = String(err.stderr ?? '').trim();
    throw Object.assign(err, {
      code: 'ETIMEDOUT',
      stderr: [`timed out after ${GIT_TIMEOUT_MS / 60_000} minutes`, stderr].filter(Boolean).join('\n'),
    });
  }
};

/** Node kills the child itself for a timeout and for an overflowing buffer; only the first is a hang. */
function timedOut(err: unknown): err is Error & { stderr?: unknown } {
  if (!(err instanceof Error) || !('killed' in err) || err.killed !== true) return false;
  return !('code' in err) || err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

// A hook or wrapper that runs Ordewell can export these, and they would point
// every git call at the outer repository instead of the workspace's, run
// another git's subcommands, or inject config such as `core.hooksPath`.
const INHERITED_GIT_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_EXEC_PATH',
];

export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of INHERITED_GIT_VARS) delete env[key];
  return env;
}

export async function tryGit(invoker: GitInvoker, cwd: string | undefined, args: string[]): Promise<GitResult> {
  try {
    const env = withPath(cleanEnv(), await invoker.resolvePath());
    const { stdout, stderr } = await invoker.exec('git', args, { cwd, env });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; code?: string | number };
    return { ok: false, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), code: e.code };
  }
}

export async function git(invoker: GitInvoker, cwd: string, args: string[]): Promise<string> {
  const result = await tryGit(invoker, cwd, args);
  if (!result.ok) throw new Error(`git ${subcommandOf(args)} failed: ${result.stderr.trim() || String(result.code ?? 'unknown error')}`);
  return result.stdout;
}

/** The subcommand git runs, past the global options in front of it (`-c commit.gpgsign=false commit` is a commit). */
export function subcommandOf(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '-C') i++;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return args[0] ?? '';
}
