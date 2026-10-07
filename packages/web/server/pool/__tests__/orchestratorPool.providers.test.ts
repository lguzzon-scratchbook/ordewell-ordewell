import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL_PROVIDERS, ModelResolver } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';

describe('OrchestratorPool.getProviderModels — configured providers', () => {
  const providerEnv = [...new Set(Object.values(ALL_PROVIDERS).flatMap((p) => [p.apiKeyEnvVar, ...p.detectEnvVars]))]
    .filter((v): v is string => Boolean(v));
  const watched = [...providerEnv, 'OPENAI_API_KEY', 'OPENAI_COMPATIBLE_BASE_URL', 'ORDEWELL_SETTINGS_PATH'];
  const savedEnv: Record<string, string | undefined> = {};
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-providers-'));
    for (const key of watched) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    vi.spyOn(ModelResolver.prototype, 'modelsForRunners').mockResolvedValue({});
    vi.spyOn(ModelResolver.prototype, 'refresh').mockResolvedValue({});
    vi.spyOn(ModelResolver.prototype, 'pickerOptions').mockResolvedValue([]);
    vi.spyOn(ModelResolver.prototype, 'getDiscoveryErrors').mockReturnValue({});
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does not count openrouter as configured when only OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai';

    const { providers } = await new OrchestratorPool().getProviderModels();

    expect(providers).toContain('openai');
    expect(providers).not.toContain('openrouter');
  });

  it('does not count a whitespace-only key as configured', async () => {
    process.env.OPENROUTER_API_KEY = '   ';

    const { providers } = await new OrchestratorPool().getProviderModels();

    expect(providers).not.toContain('openrouter');
  });
});
