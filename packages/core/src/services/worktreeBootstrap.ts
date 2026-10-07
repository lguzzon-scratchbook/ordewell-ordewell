import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import type { IsolationRepo } from '../interfaces/IWorktreeIsolation';
import { withPath } from '../utils/shellPath';
import { STATE_DIR } from '../utils/fsHelpers';
import { cleanEnv, MAX_BUFFER } from './gitExec';
import { linkPath, mirrorDir } from './worktreeLink';

const execAsync = promisify(exec);

const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Ignored artifacts worth sharing with a task worktree so it is runnable at
 * once. `.ordewell/` is deliberately not here and never will be: session and
 * skills state stays at the main root where Ordewell owns it, and a runner
 * that could reach it could corrupt it.
 */
export const LINKED_ARTIFACTS = new Set(['node_modules', 'vendor', '.venv', '.claude', '.opencode', '.codegraph', '.envrc']);
export const isEnvFile = (name: string) => name.startsWith('.env');

export const NEVER_SCANNED = new Set(['.git', STATE_DIR, 'node_modules']);

export interface BootstrapOptions {
  setupCommand?: string;
  /** The `worktreeLinks` patterns. */
  links: string[];
  platform: NodeJS.Platform;
  resolvePath: () => Promise<string>;
}

export function lexists(target: string): boolean {
  try { fs.lstatSync(target); return true; } catch { return false; }
}

export function listDir(dir: string): string[] {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

/**
 * The `worktreeLinks` entries present under `root`, relative to it. `*` and
 * `?` match within one path segment; there is no `**`, so a pattern never
 * walks a whole tree.
 */
export function matchLinks(root: string, patterns: string[]): string[] {
  const found = new Set<string>();
  for (const pattern of patterns) {
    const segments = pattern.replace(/\\/g, '/').split('/').filter((seg) => seg !== '' && seg !== '.');
    if (segments.length === 0 || segments.includes('..')) continue;
    let matches = [''];
    for (const segment of segments) matches = matches.flatMap((base) => segmentMatches(root, base, segment));
    for (const match of matches) found.add(match);
  }
  return [...found];
}

function segmentMatches(root: string, base: string, segment: string): string[] {
  const under = (name: string) => (base ? `${base}/${name}` : name);
  if (!/[*?]/.test(segment)) return lexists(path.join(root, base, segment)) ? [under(segment)] : [];
  const pattern = new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return listDir(path.join(root, base)).filter((name) => !NEVER_SCANNED.has(name) && pattern.test(name)).map(under);
}

/**
 * The `node_modules` directories under `root`, relative to it: its own and
 * those of the workspace packages its package.json lists.
 */
export function installDirs(root: string): string[] {
  const packages = matchLinks(root, workspaceGlobs(root)).map((pkg) => `${pkg}/node_modules`);
  return ['node_modules', ...packages].filter((dir) => lexists(path.join(root, dir)));
}

function workspaceGlobs(root: string): string[] {
  let manifest: unknown;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return []; }
  if (typeof manifest !== 'object' || manifest === null || !('workspaces' in manifest)) return [];
  // An array (npm, yarn) or yarn classic's `{ packages: [...] }`.
  const { workspaces } = manifest;
  const listed: unknown = typeof workspaces === 'object' && workspaces !== null && 'packages' in workspaces ? workspaces.packages : workspaces;
  if (!Array.isArray(listed)) return [];
  return listed.filter((glob): glob is string => typeof glob === 'string' && !glob.startsWith('!'));
}

/**
 * Make one repo's worktree runnable: the default artifacts, unless a setup
 * command replaces them, then the `worktreeLinks` matches, then the setup
 * command, which can rely on those. Returns what it linked and, of that,
 * what had to be copied.
 */
export async function bootstrap(repo: IsolationRepo, cwd: string, opts: BootstrapOptions): Promise<{ linked: string[]; copied: string[] }> {
  const setup = opts.setupCommand?.trim();
  const linked: string[] = [];
  const copied: string[] = [];
  const link = (name: string): void => {
    const target = path.join(cwd, name);
    // Present already means it is tracked: the checkout is the truth, not a link to the main tree's copy.
    if (lexists(target)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (linkPath(path.join(repo.root, name), target, opts.platform) === 'copy') copied.push(name);
    linked.push(name);
  };

  // A whole-folder link would resolve a workspace link such as
  // node_modules/@scope/pkg -> ../../packages/pkg from the main checkout,
  // so the task would build against the main checkout's copy of the code it
  // is changing. Mirroring entry by entry lets those links land in the worktree.
  const mirror = (name: string): void => {
    const target = path.join(cwd, name);
    if (lexists(target) || !fs.existsSync(path.dirname(target))) return;
    const source = path.join(repo.root, name);
    if (!fs.lstatSync(source).isDirectory()) return link(name);
    const mirrored = mirrorDir(source, target, { platform: opts.platform, from: repo.root, to: cwd });
    copied.push(...mirrored.map((entry) => path.join(name, entry)));
    linked.push(name);
  };

  if (!setup) {
    for (const name of fs.readdirSync(repo.root)) {
      if (name !== STATE_DIR && name !== 'node_modules' && (LINKED_ARTIFACTS.has(name) || isEnvFile(name))) link(name);
    }
    for (const dir of installDirs(repo.root)) mirror(dir);
  }
  for (const name of matchLinks(repo.root, opts.links)) link(name);
  if (setup) await runSetup(setup, repo, cwd, opts.resolvePath);
  return { linked, copied };
}

async function runSetup(command: string, repo: IsolationRepo, cwd: string, resolvePath: () => Promise<string>): Promise<void> {
  const env = withPath(cleanEnv(), await resolvePath(), {
    ORDEWELL_REPO: repo.path,
    ORDEWELL_MAIN_REPO: repo.root,
    ORDEWELL_MAIN_WORKTREE: repo.root,
  });
  try {
    await execAsync(command, { cwd, env, timeout: SETUP_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Worktree setup command failed: ${detail}`);
  }
}
