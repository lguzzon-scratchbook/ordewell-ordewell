import type { RunnerPluginManifest } from '../types';

export const KILO_MANIFEST: RunnerPluginManifest = {
  name: 'kilo',
  displayName: 'Kilo Code',
  description: 'Kilo Code CLI - open-source AI coding agent',
  version: '1.0.0',

  runner: {
    command: 'kilo',
    argsTemplate: [
      '{{if headlessSession}}', 'run', '{{/if}}',
      '{{if model}}', '--model', '{{model}}', '{{/if}}',
      '--agent', '{{mode}}',
      '{{if variant}}', '--variant', '{{thinkingEffort}}', '{{/if}}',
      '{{if buildMode}}', '--auto', '{{/if}}',
      '{{if interactive}}', '--prompt', '{{/if}}',
      '{{prompt}}',
    ],
    env: {
      KILO_CONFIG_CONTENT: '{{if interactiveVariant}}{{opencodeVariantConfig}}{{/if}}',
    },
    promptInArgs: true,
    requiresTty: true,
    submitPromptKey: true,
  },

  features: {
    modelSelection: true,
    thinkingEffort: true,
    planMode: true,
    planModeFlag: 'plan',
    buildModeFlag: 'code',
    headlessFlag: '--auto',
  },

  modelDiscovery: {
    method: 'command',
    discoveryCommands: [
      { command: 'kilo', args: ['models', '--verbose'], parser: 'opencode-models-verbose' },
      { command: 'kilo', args: ['models'], parser: 'opencode-models' },
    ],
  },

  contextFile: 'AGENTS.md',

  modes: [
    { id: 'code', label: 'Code', description: 'Full access agent for development work', cliValue: 'code', autonomous: true, safe: true },
    { id: 'plan', label: 'Plan', description: 'Read-only agent for analysis and exploration', cliValue: 'plan' },
  ],
};
