import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { isStructuredSession, type ITerminalSession, type StructuredEvent, type StructuredTurnEnd } from '../../interfaces/ITerminalRunner';
import { VerdictEngine } from '../VerdictEngine';
import { composeAugmentedPrompt } from '../promptAugment';
import { createTask, type Verdict } from '../../models/Task';

/**
 * The opt-in live check for the structured transport (ADR-0018), gated like
 * `harnessLive.smoke.test.ts` and for the same reasons: real quota, real
 * latency, no credentials in CI.
 *
 *   ORDEWELL_LIVE_AGENTS=claude-code npx vitest run --root packages/core structuredLive
 *
 * It runs in a throwaway directory under `acceptEdits`, on the cheapest model
 * unless ORDEWELL_LIVE_MODEL says otherwise. What it asserts is the transport:
 * the marker reaches `onOutput` whole, a tool call becomes one line, a soft
 * interrupt ends the turn without ending the task, a turn is not closed
 * while background work is still running, and a task completes through the
 * `task_complete` tool without an approval (ADR-0022).
 *
 * The `auto` case needs a model and an account the CLI offers auto mode on. If
 * it refuses, the case is skipped with the CLI's own words — the mode is never
 * swapped for another one (ADR-0001).
 */

const live = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).includes('claude-code');
const model = process.env.ORDEWELL_LIVE_MODEL ?? 'haiku';
// Haiku does not offer auto mode: the CLI starts in `default` and says nothing.
const autoModel = process.env.ORDEWELL_LIVE_AUTO_MODEL ?? model;
const TIMEOUT_MS = 180_000;

function turnEnds(session: ITerminalSession) {
  if (!isStructuredSession(session)) throw new Error('not a structured session');
  const ends: StructuredTurnEnd[] = [];
  let waiter: (() => void) | null = null;
  session.onTurnEnd((reason) => { ends.push(reason); waiter?.(); waiter = null; });
  return {
    session,
    ends,
    next: () => new Promise<void>((resolve) => { waiter = resolve; }),
  };
}

describe.runIf(live)('structured transport — live smoke', () => {
  it('runs a Claude Code task turn and reports its marker whole', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    writeFileSync(join(dir, 'README.md'), 'hello\n');
    const runner = new StructuredRunner();
    const marker = '<<<ORDEWELL_DONE_live-smoke>>>';
    try {
      const session = await runner.spawn({
        taskId: 'live-smoke',
        runner: 'claude-code',
        prompt: 'Run `cat README.md` with the Bash tool. Then print one final line containing only the completion marker. Build it by writing `<<<ORDEWELL_` immediately followed by `DONE_live-smoke>>>` with nothing between the two parts.',
        modelId: model,
        mode: 'acceptEdits',
        cwd: dir,
        registry: new RunnerRegistry(),
      });
      const turns = turnEnds(session);
      const chunks: string[] = [];
      const exits: number[] = [];
      session.onOutput((text) => chunks.push(text));
      session.onExit((code) => exits.push(code));

      await turns.next();
      expect(turns.ends).toEqual(['completed']);
      expect(chunks.some((chunk) => chunk.includes(marker)), session.getOutput()).toBe(true);
      expect(session.getOutput()).toMatch(/› Bash\(cat README\.md\)/);
      expect(turns.session.nativeSessionId()).toBeTruthy();

      session.kill();
      session.kill();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(exits).toHaveLength(1);
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('keeps the turn open while background work runs, and reports a marker said after it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    const runner = new StructuredRunner();
    const marker = '<<<ORDEWELL_DONE_live-background>>>';
    try {
      const startedAt = Date.now();
      const session = await runner.spawn({
        taskId: 'live-background',
        runner: 'claude-code',
        prompt: 'Start `sleep 20 && echo BG-DONE` as a background shell with the Bash tool (run_in_background). Wait for it to finish and read its output. Only then print one final line containing only the completion marker. Build it by writing `<<<ORDEWELL_` immediately followed by `DONE_live-background>>>` with nothing between the two parts.',
        modelId: model,
        mode: 'acceptEdits',
        cwd: dir,
        registry: new RunnerRegistry(),
      });
      const turns = turnEnds(session);
      const chunks: string[] = [];
      session.onOutput((text) => chunks.push(text));

      await turns.next();
      // Long enough that the 20s sleep, not a quick reply, is what held it.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15_000);
      expect(chunks.some((chunk) => chunk.includes(marker)), session.getOutput()).toBe(true);
      // Nothing straggles in after the turn, and no second turn ends.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(turns.ends).toEqual(['completed']);
      expect(chunks.filter((chunk) => chunk.includes(marker))).toHaveLength(1);
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('runs a task under auto mode, or skips with the reason the run gave', async (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    const runner = new StructuredRunner();
    const marker = '<<<ORDEWELL_DONE_live-auto>>>';
    try {
      const session = await runner.spawn({
        taskId: 'live-auto',
        runner: 'claude-code',
        prompt: 'Write a file named hello.txt containing the single word hello. Then print one final line containing only the completion marker. Build it by writing `<<<ORDEWELL_` immediately followed by `DONE_live-auto>>>` with nothing between the two parts.',
        modelId: autoModel,
        mode: 'auto',
        cwd: dir,
        registry: new RunnerRegistry(),
      });
      const turns = turnEnds(session);
      const exited = new Promise<number>((resolve) => session.onExit(resolve));
      const outcome = await Promise.race([turns.next().then(() => 'turn' as const), exited.then(() => 'exit' as const)]);

      if (outcome === 'exit' || turns.ends[0] === 'failed') {
        console.warn(`[live] auto mode on ${autoModel} skipped: ${session.getOutput().trim()}`);
        ctx.skip();
        return;
      }
      expect(turns.ends).toEqual(['completed']);
      expect(session.getOutput(), session.getOutput()).toContain(marker);
      expect(existsSync(join(dir, 'hello.txt'))).toBe(true);
      expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toContain('hello');
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('interrupts a turn and keeps the task alive for the next message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    const runner = new StructuredRunner();
    try {
      const session = await runner.spawn({
        taskId: 'live-interrupt',
        runner: 'claude-code',
        prompt: 'Use the Bash tool to run `sleep 60 && echo finished`, then summarize the result.',
        modelId: model,
        mode: 'acceptEdits',
        cwd: dir,
        registry: new RunnerRegistry(),
      });
      const turns = turnEnds(session);
      const started = new Promise<void>((resolve) => turns.session.onEvent((e) => { if (e.type === 'tool_call') resolve(); }));
      await started;

      await turns.session.interrupt();
      expect(turns.ends).toEqual(['interrupted']);
      expect(turns.session.turnState()).toBe('idle');

      turns.session.sendMessage('Reply with only the word: ok');
      await turns.next();
      expect(turns.ends).toEqual(['interrupted', 'completed']);
      expect(session.getOutput().toLowerCase()).toContain('ok');
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
  it('completes a task through task_complete in default mode, with nothing asked of a person (ADR-0022)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    const runner = new StructuredRunner();
    const task = createTask({ id: 'live-tool', title: 'Multiply', prompt: 'Work out 17 * 23 and state the result.', taskMode: 'default', completionMarker: 'live-tool' });
    const engine = new VerdictEngine();
    const verdict = new Promise<Verdict>((resolve) => engine.onVerdict((_taskId, v) => resolve(v)));
    try {
      const session = await runner.spawn({
        taskId: task.id,
        runner: 'claude-code',
        prompt: composeAugmentedPrompt(task, [task], { completionTool: true }),
        modelId: model,
        mode: 'default',
        cwd: dir,
        registry: new RunnerRegistry(),
        attempt: 1,
      });
      const turns = turnEnds(session);
      const events: StructuredEvent[] = [];
      turns.session.onEvent((event) => events.push(event));
      engine.watch(task, session);

      const decided = await verdict;
      expect(decided.outcome).toBe('pass');
      expect(decided.checks[0].name, session.getOutput()).toBe('task_complete');
      await turns.next();
      const call = events.find((e) => e.type === 'tool_call' && e.name === 'mcp__ordewell__task_complete');
      expect(call).toBeDefined();
      expect(events.find((e) => e.type === 'tool_result' && call?.type === 'tool_call' && e.id === call.id)).toMatchObject({ success: true });
      expect(events.filter((e) => e.type === 'permission_request' && !e.decided)).toEqual([]);
      console.error(`[live] task_complete verdict for Claude Code session ${turns.session.nativeSessionId()}`);
      session.kill();
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
