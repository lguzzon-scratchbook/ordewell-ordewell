import { execFile } from 'child_process';

/** Reads a runner's `--version` line, or undefined when it will not say. */
export type RunnerVersionProbe = (command: string, PATH: string) => Promise<string | undefined>;

const VERSION_TIMEOUT_MS = 5000;
const cache = new Map<string, Promise<string | undefined>>();

/**
 * Cached per command and PATH for the life of the process: the answer picks a
 * command-line shape (see `PluginRunnerDef.versioned`), and asking on every
 * task launch would put a process spawn in front of each one. A runner
 * upgraded under a running daemon is read again after a restart.
 */
export const probeRunnerVersion: RunnerVersionProbe = (command, PATH) => {
  const key = `${command}\0${PATH}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = new Promise((resolve) => {
      execFile(command, ['--version'], { env: { ...process.env, PATH }, timeout: VERSION_TIMEOUT_MS }, (err, stdout) => {
        const line = String(stdout ?? '').trim();
        resolve(err || !line ? undefined : line);
      });
    });
    cache.set(key, pending);
  }
  return pending;
};
