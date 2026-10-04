import { describe, it, expect } from 'vitest';
import { buildRunnerInvocation } from '../buildRunnerArgs';
import { majorVersion } from '../../plugins/resolveArgs';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';

const registry = new RunnerRegistry();

describe('buildRunnerInvocation — claude-code', () => {
  it('build mode without model emits --permission-mode acceptEdits', () => {
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: 'do the thing', mode: 'build', registry });
    expect(inv.command).toBe('claude');
    expect(inv.promptInArgs).toBe(true);
    expect(inv.args).toEqual(['--permission-mode', 'acceptEdits', 'do the thing']);
  });

  // Claude's prompt is a bare positional arg its CLI runs immediately, even
  // in the interactive TUI — no composer to get stuck in, so no submit key.
  it('never needs a submit key: its prompt runs on launch, interactive or not', () => {
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: 'do the thing', mode: 'build', registry });
    expect(inv.submitPromptKey).toBe(false);
  });

  it('with model + high thinking emits --thinking enabled --effort high', () => {
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: 'P', modelId: 'm', thinkingEffort: 'high', mode: 'build', registry });
    expect(inv.args).toEqual(['--model', 'm', '--thinking', 'enabled', '--effort', 'high', '--permission-mode', 'acceptEdits', 'P']);
  });

  it('with model + low thinking emits --thinking enabled --effort low', () => {
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: 'P', modelId: 'm', thinkingEffort: 'low', registry });
    expect(inv.args).toEqual(['--model', 'm', '--thinking', 'enabled', '--effort', 'low', '--permission-mode', 'acceptEdits', 'P']);
  });

  it('with model + medium thinking emits --thinking enabled --effort medium', () => {
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: 'P', modelId: 'm', thinkingEffort: 'medium', registry });
    expect(inv.args).toEqual(['--model', 'm', '--thinking', 'enabled', '--effort', 'medium', '--permission-mode', 'acceptEdits', 'P']);
  });

  it('with model + disabled thinking emits --thinking disabled', () => {
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: 'P', modelId: 'm', thinkingEffort: 'disabled', registry });
    expect(inv.args).toEqual(['--model', 'm', '--thinking', 'disabled', '--permission-mode', 'acceptEdits', 'P']);
  });

  it('with model + adaptive thinking emits --thinking adaptive', () => {
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: 'P', modelId: 'm', thinkingEffort: 'adaptive', registry });
    expect(inv.args).toEqual(['--model', 'm', '--thinking', 'adaptive', '--permission-mode', 'acceptEdits', 'P']);
  });

  it('plan mode adds --permission-mode plan', () => {
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: 'P', mode: 'plan', registry });
    expect(inv.args).toEqual(['--permission-mode', 'plan', 'P']);
  });

  it('build mode adds --permission-mode acceptEdits (not plan)', () => {
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: 'P', mode: 'build', registry });
    const pmIdx = inv.args.indexOf('--permission-mode');
    expect(pmIdx).toBeGreaterThanOrEqual(0);
    expect(inv.args[pmIdx + 1]).toBe('acceptEdits');
  });

  it('headless build mode adds --dangerously-skip-permissions', () => {
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: 'P', mode: 'build', headless: true, registry });
    expect(inv.args).toContain('--dangerously-skip-permissions');
    expect(inv.args[inv.args.length - 1]).toBe('P');
  });

  it('non-headless build mode does NOT add --dangerously-skip-permissions', () => {
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: 'P', mode: 'build', headless: false, registry });
    expect(inv.args).not.toContain('--dangerously-skip-permissions');
  });

  it('headless is ignored in plan mode (read-only; flag would conflict with --permission-mode plan)', () => {
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: 'P', mode: 'plan', headless: true, registry });
    expect(inv.args).not.toContain('--dangerously-skip-permissions');
    expect(inv.args).toEqual(['--permission-mode', 'plan', 'P']);
  });

  it('prompt is the trailing positional argument', () => {
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: 'last-arg', modelId: 'm', mode: 'plan', registry });
    expect(inv.args[inv.args.length - 1]).toBe('last-arg');
  });

  it('handles prompts with quotes/newlines as a single arg (shell quoting is the caller\'s problem)', () => {
    const tricky = 'line1\n"quoted"\nline3';
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: tricky, registry });
    expect(inv.args[inv.args.length - 1]).toBe(tricky);
  });

  it('does not pass --thinking when modelId is absent', () => {
    const inv = buildRunnerInvocation({ runner: 'claude-code', prompt: 'P', thinkingEffort: 'high', registry });
    expect(inv.args).not.toContain('--thinking');
  });
});

describe('buildRunnerInvocation — opencode', () => {
  it('interactive build mode launches the TUI: no run subcommand, --auto, --prompt', () => {
    const inv = buildRunnerInvocation({ runner: 'opencode', prompt: 'do', mode: 'build', registry });
    expect(inv.command).toBe('opencode');
    expect(inv.promptInArgs).toBe(true);
    expect(inv.args).toEqual(['--agent', 'build', '--auto', '--prompt', 'do']);
  });

  // Regression: `--prompt` only pre-fills the TUI's composer, it does not run
  // it — a surface driving this unattended must send Enter itself (the actual
  // "have to press Enter in the terminal" bug). `run`'s positional message
  // has no such gap, so headless must stay false.
  it('needs a submit key only in the interactive shape, never headless', () => {
    const interactive = buildRunnerInvocation({ runner: 'opencode', prompt: 'do', mode: 'build', registry });
    expect(interactive.submitPromptKey).toBe(true);

    const headless = buildRunnerInvocation({ runner: 'opencode', prompt: 'do', mode: 'build', headless: true, registry });
    expect(headless.submitPromptKey).toBe(false);
  });

  it('interactive plan mode emits --agent plan without --auto', () => {
    const inv = buildRunnerInvocation({ runner: 'opencode', prompt: 'do', mode: 'plan', registry });
    expect(inv.args).toEqual(['--agent', 'plan', '--prompt', 'do']);
  });

  it('headless build mode uses the run subcommand with positional prompt', () => {
    const inv = buildRunnerInvocation({ runner: 'opencode', prompt: 'do', mode: 'build', headless: true, registry });
    expect(inv.args).toEqual(['run', '--agent', 'build', '--auto', 'do']);
  });

  it('headless plan mode keeps run subcommand but drops --auto', () => {
    const inv = buildRunnerInvocation({ runner: 'opencode', prompt: 'do', mode: 'plan', headless: true, registry });
    expect(inv.args).toEqual(['run', '--agent', 'plan', 'do']);
  });

  it('passes --model when modelId provided', () => {
    const inv = buildRunnerInvocation({ runner: 'opencode', prompt: 'P', modelId: 'provider/model-x', headless: true, registry });
    expect(inv.args.slice(0, 3)).toEqual(['run', '--model', 'provider/model-x']);
  });

  it('passes --variant in headless mode when thinkingEffort provided (run accepts it)', () => {
    const inv = buildRunnerInvocation({ runner: 'opencode', prompt: 'P', thinkingEffort: 'high', modelId: 'm', headless: true, registry });
    expect(inv.args).toContain('--variant');
    expect(inv.args).toContain('high');
    expect(inv.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  // Regression: the interactive TUI rejects --variant as an unknown flag and
  // exits immediately, which Ordewell sees as the task finishing on spawn. The
  // flag must never be emitted for an interactive (non-headless) session.
  it('omits --variant in interactive mode even with thinkingEffort (TUI rejects it)', () => {
    const inv = buildRunnerInvocation({ runner: 'opencode', prompt: 'P', thinkingEffort: 'high', modelId: 'p/m', registry });
    expect(inv.args).not.toContain('--variant');
    expect(inv.args).toEqual(['--model', 'p/m', '--agent', 'build', '--auto', '--prompt', 'P']);
  });

  // Regression: an agent-scoped variant alone is silently overridden by the
  // TUI's remembered last-used variant — the config must also disable the
  // model's other variants.
  it('interactive variant is delivered via OPENCODE_CONFIG_CONTENT with other variants disabled', () => {
    const inv = buildRunnerInvocation({
      runner: 'opencode', prompt: 'P', modelId: 'p/m', thinkingEffort: 'max',
      modelVariants: ['low', 'high', 'max'], mode: 'build', registry,
    });
    expect(JSON.parse(inv.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      agent: { build: { model: 'p/m', variant: 'max' } },
      provider: { p: { models: { m: { variants: { low: { disabled: true }, high: { disabled: true } } } } } },
    });
  });

  it('interactive variant config scopes to the plan agent in plan mode', () => {
    const inv = buildRunnerInvocation({
      runner: 'opencode', prompt: 'P', modelId: 'p/m', thinkingEffort: 'high',
      modelVariants: ['high'], mode: 'plan', registry,
    });
    expect(JSON.parse(inv.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      agent: { plan: { model: 'p/m', variant: 'high' } },
    });
  });

  it('interactive variant config degrades to agent-only when the variant list is unknown', () => {
    const inv = buildRunnerInvocation({
      runner: 'opencode', prompt: 'P', modelId: 'p/m', thinkingEffort: 'high', mode: 'build', registry,
    });
    expect(JSON.parse(inv.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      agent: { build: { model: 'p/m', variant: 'high' } },
    });
  });

  it('omits OPENCODE_CONFIG_CONTENT when no thinkingEffort is selected', () => {
    const inv = buildRunnerInvocation({ runner: 'opencode', prompt: 'P', modelId: 'p/m', registry });
    expect(inv.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  it('omits OPENCODE_CONFIG_CONTENT for an unprefixed modelId (cannot be pinned per provider)', () => {
    const inv = buildRunnerInvocation({ runner: 'opencode', prompt: 'P', modelId: 'bare', thinkingEffort: 'high', modelVariants: ['high', 'max'], registry });
    expect(inv.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  it('headless prompt is the trailing positional argument (opencode run takes message as positional)', () => {
    const inv = buildRunnerInvocation({ runner: 'opencode', prompt: 'do', headless: true, registry });
    expect(inv.args).not.toContain('--prompt');
    expect(inv.args[inv.args.length - 1]).toBe('do');
  });

  it('defaults mode to build when unspecified', () => {
    const inv = buildRunnerInvocation({ runner: 'opencode', prompt: 'P', registry });
    expect(inv.args).toContain('build');
    expect(inv.args).not.toContain('plan');
  });
});

/**
 * OpenCode 2.x, recorded at v2.0.22: its TUI takes no `--model`/`--agent`, its
 * `run` has no `--variant`, and both attach to a background service unless
 * `--standalone`. Checked against the binary, not memory.
 */
describe('buildRunnerInvocation — opencode 2.x', () => {
  const v2 = { runner: 'opencode', runnerVersion: 'opencode v2.0.22', registry } as const;

  it('reads the major from the version line, however the CLI prints it', () => {
    expect(majorVersion('opencode v2.0.22')).toBe(2);
    expect(majorVersion('1.18.34')).toBe(1);
    expect(majorVersion(undefined)).toBeUndefined();
    expect(majorVersion('dev build')).toBeUndefined();
  });

  it('runs headless with the agent, the variant on the model, its own server and auto approvals', () => {
    const inv = buildRunnerInvocation({ ...v2, prompt: 'P', mode: 'build', modelId: 'opencode-go/m', thinkingEffort: 'high', headless: true, interactive: false });
    expect(inv.args).toEqual(['run', '--agent', 'build', '--model', 'opencode-go/m#high', '--standalone', '--auto', 'P']);
    expect(inv.env).toEqual({});
  });

  it('keeps a plan task headless without auto approvals or a variant it was not given', () => {
    const inv = buildRunnerInvocation({ ...v2, prompt: 'P', mode: 'plan', modelId: 'opencode-go/m', headless: true, interactive: false });
    expect(inv.args).toEqual(['run', '--agent', 'plan', '--model', 'opencode-go/m', '--standalone', 'P']);
  });

  it('opens the TUI with the agent and model on the config, since its flags take neither', () => {
    const inv = buildRunnerInvocation({ ...v2, prompt: 'P', mode: 'plan', modelId: 'opencode-go/m', headless: true, interactive: true });
    expect(inv.args).toEqual(['--standalone', '--prompt', 'P']);
    expect(JSON.parse(inv.env.OPENCODE_CONFIG_CONTENT)).toEqual({ default_agent: 'plan', agent: { plan: { model: 'opencode-go/m' } } });
    expect(inv.submitPromptKey).toBe(true);
  });

  it('pins the TUI\'s variant and disables the others, as on 1.x', () => {
    const inv = buildRunnerInvocation({ ...v2, prompt: 'P', mode: 'build', modelId: 'opencode-go/m', thinkingEffort: 'high', modelVariants: ['low', 'high'], headless: true, interactive: true });
    expect(inv.args).toEqual(['--standalone', '--auto', '--prompt', 'P']);
    expect(JSON.parse(inv.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      default_agent: 'build',
      agent: { build: { model: 'opencode-go/m', variant: 'high' } },
      provider: { 'opencode-go': { models: { m: { variants: { low: { disabled: true } } } } } },
    });
  });

  it('keeps the 1.x command line when the version cannot be read', () => {
    const inv = buildRunnerInvocation({ runner: 'opencode', prompt: 'P', mode: 'build', modelId: 'p/m', thinkingEffort: 'high', headless: true, interactive: false, registry });
    expect(inv.args).toEqual(['run', '--model', 'p/m', '--agent', 'build', '--variant', 'high', '--auto', 'P']);
  });
});
