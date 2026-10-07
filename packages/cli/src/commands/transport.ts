import { ensureDaemon, resolvePort } from '../daemon';
import { ApiClient } from '../apiClient';

const describe = (transport: unknown): string =>
  `Runner transport: ${transport === 'terminal' ? 'terminal' : 'structured'} — applies from the next run`;

export async function handleTransport(subArgs: string[], api?: ApiClient): Promise<void> {
  const action = subArgs[0];
  const port = api ? undefined : await ensureDaemon(resolvePort(subArgs));
  const client = api || new ApiClient(port);

  if (action === 'terminal' || action === 'structured') {
    const result = await client.sendCommand('transport', { action });
    console.log(describe(result.settings?.runnerTransport));
  } else {
    const settings = await client.getSettings();
    console.log(describe(settings.runnerTransport));
    console.log('Usage: ordewell transport [terminal|structured]');
  }
}
