import { describe, it, expect } from 'vitest';
import { resolveArgs, resolveTaskRunnerFlags, resolveModeSettings, ResolveError } from '../resolveArgs';
import { CODEX_MANIFEST } from '../builtin/codex.manifest';
import { CLAUDE_CODE_MANIFEST } from '../builtin/claude-code.manifest';
import { OPENCODE_MANIFEST } from '../builtin/opencode.manifest';
import type { RunnerPluginManifest, ResolveContext } from '../types';

function basicManifest(overrides?: Partial<RunnerPluginManifest>): RunnerPluginManifest {
  return {
    name: 'test',
    displayName: 'Test',
    description: 'Test manifest',
    version: '1.0.0',
    runner: {
      command: 'test-cli',
      argsTemplate: ['{{prompt}}'],
      promptInArgs: true,
    },
    features: {
      modelSelection: false,
      thinkingEffort: false,
      planMode: false,
      planModeFlag: '',
    },
    modelDiscovery: {
      method: 'hardcoded',
      fallbackModels: [],
    },
    ...overrides,
  };
}

function ctx(overrides?: Partial<ResolveContext>): ResolveContext {
  return { prompt: 'do the thing', mode: 'build', ...overrides };
}

describe('resolveArgs', () => {
  it('resolves a simple manifest', () => {
    const result = resolveArgs(basicManifest(), ctx());
    expect(result.command).toBe('test-cli');
    expect(result.args).toEqual(['do the thing']);
    expect(result.promptInArgs).toBe(true);
  });

  it('defaults submitPromptKey to false when the manifest does not declare it', () => {
    const result = resolveArgs(basicManifest(), ctx());
    expect(result.submitPromptKey).toBe(false);
  });

  it('sets submitPromptKey only when the manifest declares it AND the shape is interactive', () => {
    const m = basicManifest({
      runner: { command: 'c', argsTemplate: ['{{prompt}}'], promptInArgs: true, submitPromptKey: true },
    });
    expect(resolveArgs(m, ctx({ interactive: true })).submitPromptKey).toBe(true);
    expect(resolveArgs(m, ctx({ interactive: false })).submitPromptKey).toBe(false);
    expect(resolveArgs(m, ctx({ headless: true })).submitPromptKey).toBe(false);
  });

  it('injects model when present', () => {
    const m = basicManifest({
      runner: { command: 'c', argsTemplate: ['--model', '{{model}}', '{{prompt}}'], promptInArgs: true },
      features: { modelSelection: true, thinkingEffort: false, planMode: false, planModeFlag: '' },
    });
    const result = resolveArgs(m, ctx({ model: 'gpt-4' }));
    expect(result.args).toEqual(['--model', 'gpt-4', 'do the thing']);
  });

  it('without conditional, a missing model token becomes empty and is filtered', () => {
    const m = basicManifest({
      runner: { command: 'c', argsTemplate: ['--model', '{{model}}', '{{prompt}}'], promptInArgs: true },
      features: { modelSelection: true, thinkingEffort: false, planMode: false, planModeFlag: '' },
    });
    const result = resolveArgs(m, ctx({ model: undefined }));
    // --model is a literal so it still appears; {{model}} resolves to '' and is dropped
    expect(result.args).toEqual(['--model', 'do the thing']);
  });

  it('resolves thinking effort', () => {
    const m = basicManifest({
      runner: { command: 'c', argsTemplate: ['--thinking', '{{thinkingEffort}}', '{{prompt}}'], promptInArgs: true },
      features: { modelSelection: false, thinkingEffort: true, planMode: false, planModeFlag: '' },
    });
    const result = resolveArgs(m, ctx({ thinkingEffort: 'high' }));
    expect(result.args).toEqual(['--thinking', 'high', 'do the thing']);
  });

  it('resolves mode token', () => {
    const m = basicManifest({
      runner: { command: 'c', argsTemplate: ['--agent', '{{mode}}', '{{prompt}}'], promptInArgs: true },
      features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
    });
    const result = resolveArgs(m, ctx({ mode: 'plan' }));
    expect(result.args).toEqual(['--agent', 'plan', 'do the thing']);
  });

  describe('conditional blocks', () => {
    it('includes {{if model}} block when model is set', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if model}}', '--model', '{{model}}', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: true, thinkingEffort: false, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ model: 'claude-3' }));
      expect(result.args).toContain('--model');
      expect(result.args).toContain('claude-3');
    });

    it('skips {{if model}} block when model is not set', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if model}}', '--model', '{{model}}', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: true, thinkingEffort: false, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ model: undefined }));
      expect(result.args).not.toContain('--model');
      expect(result.args).toEqual(['do the thing']);
    });

    it('includes {{if thinking}} block when thinking + model', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if thinking}}', '--thinking', 'on', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: true, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ thinkingEffort: 'high', model: 'm' }));
      expect(result.args).toContain('--thinking');
    });

    it('skips {{if thinking}} block without thinking effort', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if thinking}}', '--thinking', 'on', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: true, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ thinkingEffort: undefined, model: 'm' }));
      expect(result.args).not.toContain('--thinking');
    });

    it('includes {{if planMode}} block in plan mode', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if planMode}}', '--read-only', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: true, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ mode: 'plan' }));
      expect(result.args).toContain('--read-only');
    });

    it('skips {{if planMode}} block in build mode', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if planMode}}', '--read-only', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: true, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ mode: 'build' }));
      expect(result.args).not.toContain('--read-only');
    });

    it('includes {{if buildMode}} block in build mode', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if buildMode}}', '--write', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: true, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ mode: 'build' }));
      expect(result.args).toContain('--write');
    });

    it('includes {{if headless}} block when headless + not plan mode', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if headless}}', '--yes', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '', headlessFlag: '--yes' },
      });
      const result = resolveArgs(m, ctx({ headless: true, mode: 'build' }));
      expect(result.args).toContain('--yes');
    });

    it('skips {{if headless}} block in plan mode even with headless', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if headless}}', '--yes', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '', headlessFlag: '--yes' },
      });
      const result = resolveArgs(m, ctx({ headless: true, mode: 'plan' }));
      expect(result.args).not.toContain('--yes');
    });
  });

  describe('feature tokens', () => {
    it('resolves {{feature:thinkingFlags}}', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{feature:thinkingFlags}}', '{{prompt}}'], promptInArgs: true },
        features: {
          modelSelection: false, thinkingEffort: true, planMode: false, planModeFlag: '',
          thinkingFlag: '--thinking',
        },
      });
      const result = resolveArgs(m, ctx({ thinkingEffort: 'high', model: 'm' }));
      expect(result.args).toEqual(['--thinking', 'enabled', '--effort', 'high', 'do the thing']);
    });

    it('resolves {{feature:thinkingVal}} for high', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['--thinking', '{{feature:thinkingVal}}', '{{prompt}}'], promptInArgs: true },
        features: {
          modelSelection: false, thinkingEffort: true, planMode: false, planModeFlag: '',
          thinkingValueEnabled: 'enabled',
          thinkingValueDisabled: 'disabled',
          thinkingValueAdaptive: 'adaptive',
        },
      });
      const result = resolveArgs(m, ctx({ thinkingEffort: 'high', model: 'm' }));
      expect(result.args).toEqual(['--thinking', 'enabled', 'do the thing']);
    });

    it('resolves {{feature:permissionModeVal}} from manifest map', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['--perm', '{{feature:permissionModeVal}}', '{{prompt}}'], promptInArgs: true },
        features: {
          modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '',
          permissionModeValues: { build: 'acceptEdits', plan: 'plan' },
        },
      });
      const result = resolveArgs(m, ctx({ mode: 'build' }));
      expect(result.args).toEqual(['--perm', 'acceptEdits', 'do the thing']);
    });

    it('resolves {{feature:permissionModeVal}} with fallback to mode id', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['--perm', '{{feature:permissionModeVal}}', '{{prompt}}'], promptInArgs: true },
        features: {
          modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '',
          // no permissionModeValues map — falls back to mode id
        },
      });
      const result = resolveArgs(m, ctx({ mode: 'plan' }));
      expect(result.args).toEqual(['--perm', 'plan', 'do the thing']);
    });

    it('resolves {{feature:headless}}', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{feature:headless}}', '{{prompt}}'], promptInArgs: true },
        features: {
          modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '',
          headlessFlag: '--skip-perms',
        },
      });
      const result = resolveArgs(m, ctx({ headless: true }));
      expect(result.args).toEqual(['--skip-perms', 'do the thing']);
    });

    it('resolves {{feature:planMode}} and {{feature:buildMode}}', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{feature:planMode}}', '{{feature:buildMode}}', '{{prompt}}'], promptInArgs: true },
        features: {
          modelSelection: false, thinkingEffort: false, planMode: true, planModeFlag: '--plan',
          buildModeFlag: '--build',
        },
      });
      const result = resolveArgs(m, ctx());
      expect(result.args).toEqual(['--plan', '--build', 'do the thing']);
    });

    it('resolves unknown {{feature:*}} tokens to empty string', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{feature:unknown}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx());
      expect(result.args).toEqual(['do the thing']);
    });
  });

  describe('env substitution', () => {
    it('substitutes variables in env block', () => {
      const m = basicManifest({
        runner: {
          command: 'c',
          argsTemplate: ['{{prompt}}'],
          promptInArgs: true,
          env: { MODEL: '{{model}}', MODE: '{{mode}}' },
        },
        features: { modelSelection: true, thinkingEffort: false, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ model: 'gpt-4' }));
      expect(result.env).toEqual({ MODEL: 'gpt-4', MODE: 'build' });
    });

    it('keeps an {{if}} env block when the condition holds', () => {
      const m = basicManifest({
        runner: {
          command: 'c',
          argsTemplate: ['{{prompt}}'],
          promptInArgs: true,
          env: { CONFIG: '{{if thinking}}{"model":"{{model}}","variant":"{{thinkingEffort}}"}{{/if}}' },
        },
        features: { modelSelection: true, thinkingEffort: true, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ model: 'p/m', thinkingEffort: 'high' }));
      expect(result.env).toEqual({ CONFIG: '{"model":"p/m","variant":"high"}' });
    });

    it('omits an env entry whose {{if}} condition fails instead of exporting an empty string', () => {
      const m = basicManifest({
        runner: {
          command: 'c',
          argsTemplate: ['{{prompt}}'],
          promptInArgs: true,
          env: { CONFIG: '{{if thinking}}{"variant":"{{thinkingEffort}}"}{{/if}}' },
        },
        features: { modelSelection: true, thinkingEffort: true, planMode: false, planModeFlag: '' },
      });
      // {{if thinking}} requires model AND thinkingEffort — model alone is not enough
      expect(resolveArgs(m, ctx({ model: 'p/m' })).env).toEqual({});
      expect(resolveArgs(m, ctx({ thinkingEffort: 'high' })).env).toEqual({});
    });

    it('omits env entries that resolve to empty even without conditionals', () => {
      const m = basicManifest({
        runner: {
          command: 'c',
          argsTemplate: ['{{prompt}}'],
          promptInArgs: true,
          env: { MODEL: '{{model}}', MODE: '{{mode}}' },
        },
        features: { modelSelection: true, thinkingEffort: false, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ model: undefined }));
      expect(result.env).toEqual({ MODE: 'build' });
    });
  });

  describe('error handling', () => {
    it('throws on nested conditional blocks', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if model}}', '{{if thinking}}', 'nested', '{{/if}}', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: true, thinkingEffort: true, planMode: false, planModeFlag: '' },
      });
      expect(() => resolveArgs(m, ctx({ model: 'm', thinkingEffort: 'high' }))).toThrow(ResolveError);
    });

    it('throws on unmatched {{/if}}', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
      });
      expect(() => resolveArgs(m, ctx())).toThrow(ResolveError);
    });

    it('throws on unclosed conditional block', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if model}}', '--model', '{{model}}'], promptInArgs: true },
        features: { modelSelection: true, thinkingEffort: false, planMode: false, planModeFlag: '' },
      });
      expect(() => resolveArgs(m, ctx({ model: 'm' }))).toThrow(ResolveError);
    });
  });
});

describe('resolveArgs — Codex manifest', () => {
  it('headless build task: exec subcommand, model, effort config override, workspace-write sandbox', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'do it', mode: 'agent', model: 'gpt-5.6-sol', thinkingEffort: 'high', headless: true,
    });
    expect(result.command).toBe('codex');
    expect(result.args).toEqual([
      'exec', '--skip-git-repo-check',
      '-c', 'approval_policy=on-request', '-c', 'approvals_reviewer=auto_review',
      '-m', 'gpt-5.6-sol',
      '-c', 'model_reasoning_effort=high',
      '--sandbox', 'workspace-write',
      'do it',
    ]);
  });

  it('interactive task: no exec subcommand, approvals off, same model/effort/sandbox flags', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'do it', mode: 'agent', model: 'gpt-5.6-terra', thinkingEffort: 'ultra', headless: false,
    });
    expect(result.args).toEqual([
      '-a', 'on-request', '-c', 'approvals_reviewer=auto_review',
      '-m', 'gpt-5.6-terra',
      '-c', 'model_reasoning_effort=ultra',
      '--sandbox', 'workspace-write',
      'do it',
    ]);
  });

  // Regression (tmux TUI): an unattended interactive run is still autonomous.
  // Resolving `exec` here streamed CLI output into a window meant to show the
  // TUI; `-a never` and the pre-trusted workspace are what `exec` gave for free.
  it('an autonomous interactive session launches the TUI, not exec', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'do it', mode: 'agent', model: 'gpt-5.6-sol', headless: true, interactive: true, cwd: '/w/s',
    });
    expect(result.args).toEqual([
      '-a', 'on-request', '-c', 'approvals_reviewer=auto_review',
      '-c', 'projects."/w/s".trust_level="trusted"',
      '-m', 'gpt-5.6-sol',
      '--sandbox', 'workspace-write',
      'do it',
    ]);
  });

  // `codex exec` has no -a flag and never asks about directory trust, so both
  // interactive-only entries must stay out of the piped shape.
  it('the piped shape gets neither the approval flag nor the trust override', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'do it', mode: 'agent', headless: true, interactive: false, cwd: '/w/s',
    });
    expect(result.args).not.toContain('-a');
    expect(result.args.join(' ')).not.toContain('trust_level');
  });

  // A dangling `-c` with no value would make codex reject the invocation.
  it('drops the whole trust pair when no cwd is known', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'do it', mode: 'agent', headless: true, interactive: true,
    });
    expect(result.args).toEqual([
      '-a', 'on-request', '-c', 'approvals_reviewer=auto_review',
      '--sandbox', 'workspace-write', 'do it',
    ]);
  });

  it('quotes a workspace path with spaces as a single TOML-keyed argument', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'do it', mode: 'agent', headless: true, interactive: true, cwd: '/w/my repo',
    });
    expect(result.args).toContain('projects."/w/my repo".trust_level="trusted"');
  });

  it('plan mode maps to the read-only sandbox', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'analyze', mode: 'plan', model: 'gpt-5.5', headless: true,
    });
    expect(result.args).toEqual([
      'exec', '--skip-git-repo-check',
      '-m', 'gpt-5.5',
      '--sandbox', 'read-only',
      'analyze',
    ]);
  });

  it('fullAccess mode maps to danger-full-access', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'go', mode: 'fullAccess', model: 'gpt-5.6-sol', headless: true,
    });
    expect(result.args).toContain('--sandbox');
    expect(result.args).toContain('danger-full-access');
  });

  // Full: nothing to review, so neither shape carries a reviewer, and the
  // interactive shape keeps `-a never`; `exec` already implies it.
  it.each([
    ['interactive', { interactive: true }, ['-a', 'never', '--sandbox', 'danger-full-access', 'go']],
    ['headless', { headless: true }, ['exec', '--skip-git-repo-check', '--sandbox', 'danger-full-access', 'go']],
  ])('fullAccess on the %s shape never asks and has no reviewer', (_shape, shape, expected) => {
    const result = resolveArgs(CODEX_MANIFEST, { prompt: 'go', mode: 'fullAccess', ...shape });
    expect(result.args).toEqual(expected);
  });

  it('plan mode stays approval-free on the interactive shape', () => {
    const result = resolveArgs(CODEX_MANIFEST, { prompt: 'look', mode: 'plan', interactive: true });
    expect(result.args).toEqual(['-a', 'never', '--sandbox', 'read-only', 'look']);
  });

  it('an unmapped mode id keeps the previous interactive default of never asking', () => {
    const result = resolveArgs(CODEX_MANIFEST, { prompt: 'go', mode: 'custom', interactive: true });
    expect(result.args.slice(0, 2)).toEqual(['-a', 'never']);
  });

  it('omits the effort config pair when no thinking effort is set', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'go', mode: 'agent', model: 'gpt-5.4', headless: true,
    });
    expect(result.args.join(' ')).not.toContain('model_reasoning_effort');
  });

  it('legacy build mode id aliases to workspace-write', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'go', mode: 'build', model: 'gpt-5.4', headless: true,
    });
    expect(result.args).toContain('workspace-write');
  });
});

describe('resolveModeSettings', () => {
  it('reads the approval policy and reviewer a Codex mode carries', () => {
    expect(resolveModeSettings(CODEX_MANIFEST, 'agent')).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
    expect(resolveModeSettings(CODEX_MANIFEST, 'fullAccess')).toEqual({ approvalPolicy: 'never' });
    expect(resolveModeSettings(CODEX_MANIFEST, 'plan')).toEqual({ approvalPolicy: 'never' });
  });

  it('is empty for a runner whose manifest declares neither map', () => {
    expect(resolveModeSettings(CLAUDE_CODE_MANIFEST, 'auto')).toEqual({});
  });

  it('treats a missing mode like an unmapped one', () => {
    expect(resolveModeSettings(CODEX_MANIFEST, undefined)).toEqual({});
  });
});

/**
 * The structured transport reads a task's mode and effort from the same
 * manifest as the terminal template (ADR-0018, C1). The resolver stays
 * runner-neutral: it hands over the raw effort id, and each adapter maps it
 * to its own protocol.
 */
describe('resolveTaskRunnerFlags', () => {
  it('hands a Codex task its sandbox value and the raw effort id, with no Claude flags', () => {
    expect(resolveTaskRunnerFlags(CODEX_MANIFEST, { mode: 'agent', model: 'gpt-5.5', thinkingEffort: 'high' })).toEqual({
      permissionMode: 'workspace-write',
      effort: 'high',
      modeSettings: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
    });
  });

  it('hands a Claude task the raw effort id too: the thinking flags are the adapter\'s to build', () => {
    expect(resolveTaskRunnerFlags(CLAUDE_CODE_MANIFEST, { mode: 'bypassPermissions', model: 'sonnet', thinkingEffort: 'max' })).toEqual({
      permissionMode: 'bypassPermissions',
      effort: 'max',
      modeSettings: {},
    });
  });

  it.each([
    [CLAUDE_CODE_MANIFEST, 'default'],
    [CODEX_MANIFEST, 'agent'],
  ])('drops the effort without a model, behind the same gate as the template (%#)', (manifest, mode) => {
    expect(resolveTaskRunnerFlags(manifest, { mode, thinkingEffort: 'high' })).not.toHaveProperty('effort');
  });

  it.each([
    ['build', 'acceptEdits'],
    ['', 'default'],
    ['default', 'default'],
    ['auto', 'auto'],
    ['plan', 'plan'],
    // A mode the manifest does not map is passed through as its own id, as the template does.
    ['dontAsk', 'dontAsk'],
  ])('maps Claude mode "%s" to --permission-mode %s', (mode, expected) => {
    expect(resolveTaskRunnerFlags(CLAUDE_CODE_MANIFEST, { mode }).permissionMode).toBe(expected);
  });

  it.each([
    // The terminal transport runs every mode but plan with `--auto`; the structured one answers the same requests.
    ['build', true, { permissionMode: 'build', modeSettings: { approvals: 'auto' } }],
    ['plan', false, { permissionMode: 'plan', modeSettings: {} }],
  ])('hands an OpenCode %s task its agent and how its requests are answered', (mode, auto, expected) => {
    expect(resolveTaskRunnerFlags(OPENCODE_MANIFEST, { mode })).toEqual(expected);
    expect(resolveArgs(OPENCODE_MANIFEST, { mode, prompt: 'p', headless: true }).args.includes('--auto')).toBe(auto);
  });

  describe('per-mode settings', () => {
    const manifest = basicManifest({
      features: {
        modelSelection: true, thinkingEffort: true, planMode: true, planModeFlag: '--sandbox',
        permissionModeValues: { agent: 'workspace-write', plan: 'read-only', fullAccess: 'danger-full-access' },
        modeSettings: {
          approvalPolicy: { agent: 'on-request', fullAccess: 'never', default: 'untrusted' },
          approvalsReviewer: { agent: 'user' },
        },
      },
    });

    it.each([
      ['agent', { approvalPolicy: 'on-request', approvalsReviewer: 'user' }],
      ['fullAccess', { approvalPolicy: 'never' }],
      // A mode no map names leaves every setting to the runner's default.
      ['plan', {}],
      // No mode reads as `default`, as it does for the permission-mode value.
      ['', { approvalPolicy: 'untrusted' }],
    ])('resolves mode "%s" to %j', (mode, expected) => {
      expect(resolveTaskRunnerFlags(manifest, { mode }).modeSettings).toEqual(expected);
    });
  });
});

describe('Claude Code manifest — autonomy levels', () => {
  const byId = (id: string) => CLAUDE_CODE_MANIFEST.modes?.find((m) => m.id === id);

  it('Auto is the safe mode and Bypass permissions the autonomous one', () => {
    expect(byId('auto')).toMatchObject({ label: 'Auto', cliValue: 'auto', safe: true });
    expect(byId('bypassPermissions')).toMatchObject({ label: 'Bypass permissions', autonomous: true });
    expect(CLAUDE_CODE_MANIFEST.modes?.filter((m) => m.safe).map((m) => m.id)).toEqual(['auto']);
  });

  it('keeps Ask before edits selectable without a level tag', () => {
    expect(byId('default')).toBeDefined();
    expect(byId('default')?.safe).toBeUndefined();
    expect(byId('default')?.autonomous).toBeUndefined();
  });

  it('describes Auto as a classifier deciding each action', () => {
    expect(byId('auto')?.description).toMatch(/classifier/i);
  });
});
