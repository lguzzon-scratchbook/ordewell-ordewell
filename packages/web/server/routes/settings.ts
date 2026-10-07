import { Hono } from 'hono';
import type { SettingsResponse, SettingsUpdateResponse } from '@ordewell/core';
import type { OrchestratorPool } from '../pool/orchestratorPool';
import { refuse } from './errors';

export function settingsRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/', (c) => {
    const settings: SettingsResponse = pool.getSettings();
    return c.json(settings);
  });

  router.patch('/', async (c) => {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
      return refuse(c, 400, 'At least one setting field is required');
    }
    const result: SettingsUpdateResponse = pool.updateSettings(body);
    return c.json(result);
  });

  return router;
}
