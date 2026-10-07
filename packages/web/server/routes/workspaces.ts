import { Hono } from 'hono';
import type { WorkspacesResponse } from '@ordewell/core';
import { scanWorkspaces } from '../pool/orchestratorPool';

export function workspacesRoute() {
  const router = new Hono();

  router.get('/', (c) => {
    const workspaces = scanWorkspaces();
    return c.json({ workspaces } satisfies WorkspacesResponse);
  });

  return router;
}
