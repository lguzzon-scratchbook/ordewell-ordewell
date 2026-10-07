import { describe, it, expect } from 'vitest';
import { CodexRpc, type RpcResponse } from '../codexRpc';

function connection() {
  const written: Array<Record<string, unknown>> = [];
  const rpc = new CodexRpc((payload) => written.push(payload as Record<string, unknown>));
  return { rpc, written };
}

const noEmit = () => {};

describe('CodexRpc', () => {
  it('numbers requests from 1, so initialize is 1 and the thread request after it 2', () => {
    const { rpc, written } = connection();
    rpc.send('initialize', {});
    rpc.send('thread/start', { cwd: '/repo' });
    expect(written).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'thread/start', params: { cwd: '/repo' } },
    ]);
  });

  it('settles a request inside the dispatch of its answer, before the next line of the chunk is read', () => {
    const { rpc } = connection();
    const seen: string[] = [];
    rpc.send('turn/steer', {}, (response) => seen.push(response.ok ? 'accepted' : 'refused'));

    expect(rpc.dispatch({ id: 1, result: {} }, noEmit)).toBe(true);
    seen.push('next line');
    expect(seen).toEqual(['accepted', 'next line']);
  });

  it('hands a refusal over with the server\'s words', () => {
    const { rpc } = connection();
    let answer: RpcResponse | undefined;
    rpc.send('turn/steer', {}, (response) => { answer = response; });
    rpc.dispatch({ id: 1, error: { message: 'no active turn' } }, noEmit);
    expect(answer).toEqual({ ok: false, closed: false, message: 'no active turn' });
  });

  it('hands the emitter of the line that carried the answer to the handler', () => {
    const { rpc } = connection();
    const emit = () => {};
    let given: unknown;
    rpc.send('turn/start', {}, (_response, handed) => { given = handed; });
    rpc.dispatch({ id: 1, result: {} }, emit);
    expect(given).toBe(emit);
  });

  it('frames a request without writing it', () => {
    const { rpc, written } = connection();
    const line = rpc.frame('turn/start', { threadId: 't' }, () => {});
    expect(written).toEqual([]);
    expect(line).toBe('{"jsonrpc":"2.0","id":1,"method":"turn/start","params":{"threadId":"t"}}\n');

    let answered = false;
    rpc.dispatch({ id: 1, result: {} }, noEmit);
    rpc.frame('turn/start', {}, () => { answered = true; });
    rpc.dispatch({ id: 2, result: {} }, noEmit);
    expect(answered).toBe(true);
  });

  it('answers a call as a promise', async () => {
    const { rpc } = connection();
    const answered = rpc.call('initialize', {});
    rpc.dispatch({ id: 1, result: { userAgent: 'codex' } }, noEmit);
    await expect(answered).resolves.toEqual({ ok: true, result: { userAgent: 'codex' } });
  });

  it('claims every response, and nothing that is a request or a notification', () => {
    const { rpc } = connection();
    expect(rpc.dispatch({ id: 99, result: {} }, noEmit)).toBe(true);
    expect(rpc.dispatch({ id: 1, method: 'item/commandExecution/requestApproval' }, noEmit)).toBe(false);
    expect(rpc.dispatch({ method: 'turn/completed' }, noEmit)).toBe(false);
  });

  it('settles a request once: a second answer under the same id reaches no one', () => {
    const { rpc } = connection();
    let answers = 0;
    rpc.send('turn/steer', {}, () => { answers += 1; });
    rpc.dispatch({ id: 1, result: {} }, noEmit);
    rpc.dispatch({ id: 1, result: {} }, noEmit);
    expect(answers).toBe(1);
  });

  it('answers a request of Codex\'s own under its id, as a result or as an error', () => {
    const { rpc, written } = connection();
    rpc.respond(7, { decision: 'decline' });
    rpc.respondError('abc', -32601, 'not handled');
    expect(written).toEqual([
      { jsonrpc: '2.0', id: 7, result: { decision: 'decline' } },
      { jsonrpc: '2.0', id: 'abc', error: { code: -32601, message: 'not handled' } },
    ]);
  });

  it('fails everything waiting when it closes, and later requests at once without a write', async () => {
    const { rpc, written } = connection();
    const first = rpc.call('turn/steer', {});
    const second = rpc.call('turn/interrupt', {});
    const sent = written.length;

    rpc.close('process ended');
    await expect(first).resolves.toEqual({ ok: false, closed: true, message: 'process ended' });
    await expect(second).resolves.toEqual({ ok: false, closed: true, message: 'process ended' });

    await expect(rpc.call('turn/steer', {})).resolves.toMatchObject({ ok: false, closed: true });
    expect(written).toHaveLength(sent);
  });
});
