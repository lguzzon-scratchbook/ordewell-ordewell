import { describe, it, expect, afterEach } from 'vitest';
import { cleanEnv, execFileWithTimeout, git, subcommandOf } from '../gitExec';

describe('gitExec', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('names the subcommand past global options', () => {
    expect(subcommandOf(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q'])).toBe('commit');
    expect(subcommandOf(['-C', '/repo', 'status'])).toBe('status');
    expect(subcommandOf(['--version'])).toBe('--version');
  });

  it('reports a failed rescue commit as a commit', async () => {
    const invoker = {
      exec: async () => { throw Object.assign(new Error('boom'), { stderr: 'hook refused', code: 1 }); },
      resolvePath: async () => '',
    };
    await expect(git(invoker, '/repo', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'x'])).rejects.toThrow('git commit failed: hook refused');
  });

  it('drops inherited variables that would redirect or reconfigure git', () => {
    Object.assign(process.env, { GIT_DIR: '/outer', GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/x'", GIT_CONFIG_COUNT: '1', GIT_EXEC_PATH: '/other' });
    const env = cleanEnv();
    for (const key of ['GIT_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_EXEC_PATH']) expect(env[key]).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  describe('a call that never returns', () => {
    const hang = ['-e', 'setInterval(() => {}, 1000)'];

    it('is ended with SIGTERM so git can release its locks, and reported as a timeout', async () => {
      const exec = execFileWithTimeout(300);
      const err = await exec(process.execPath, hang, { env: process.env }).catch((e: unknown) => e);

      expect(err).toMatchObject({ code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' });
      expect((err as { stderr: string }).stderr).toMatch(/^timed out after 0\.3 seconds/);
    });
  });
});
