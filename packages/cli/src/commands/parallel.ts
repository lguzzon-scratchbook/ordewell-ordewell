import { parseMaxParallel } from '@ordewell/core';
import type { ApiClient } from '../apiClient';
import { positionals } from '../utils';
import { connect, fail, persistEnv } from './shared';

const USAGE = 'Usage: ordewell parallel [<number of tasks, 1 or more>]';

/** How many AI tasks run at once. Applies to a run already going, and to every later one. */
export async function handleParallel(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const [wanted] = positionals(subArgs);
  const api = await connect(subArgs, injectedApi);

  if (!wanted || wanted === 'show') {
    const settings = await api.getSettings();
    console.log(`Up to ${String(settings.maxParallel ?? '?')} AI tasks run at once. Change with: ordewell parallel <n>`);
    return;
  }

  const limit = parseMaxParallel(wanted);
  if (limit === null) fail(`"${wanted}" is not a number of tasks (1 or more).`, USAGE);
  await persistEnv(api, { ORDEWELL_MAX_PARALLEL: String(limit) });
  console.log(`Up to ${limit} AI task${limit === 1 ? '' : 's'} now run at once.`);
}
