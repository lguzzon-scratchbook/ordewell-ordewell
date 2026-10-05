import { describe, it, expect } from 'vitest';
import { OpenCodeAdapter } from '../OpenCodeAdapter';
import type { AgentEvent, AgentProcessDeps } from '../AgentAdapter';
import { fakeSpawn, openCodeFixture } from '../../__tests__/harnessTestKit';

/**
 * Replays turns recorded from `opencode serve` 1.18.32 (the fixtures under
 * fixtures/harness/opencode). Every frame is delivered before the message
 * POST settles, which is the order the live server produced them in.
 */
async function replay(name: string): Promise<AgentEvent[]> {
  const { sessionId, frames, response } = openCodeFixture(name);
  let drained: () => void = () => {};
  const allDelivered = new Promise<void>((resolve) => { drained = resolve; });

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace('http://127.0.0.1:4096', '');
    const method = init?.method ?? 'GET';
    if (path === '/event') {
      const pending = [...frames];
      const signal = init?.signal;
      const reader = {
        read: () => {
          if (pending.length) return Promise.resolve({ done: false, value: new TextEncoder().encode(pending.shift()!) });
          drained();
          return new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
            if (signal?.aborted) return resolve({ done: true });
            signal?.addEventListener('abort', () => resolve({ done: true }), { once: true });
          });
        },
      };
      return { ok: true, status: 200, statusText: 'OK', body: { getReader: () => reader } } as unknown as Response;
    }
    const json = method === 'POST' && path === '/session'
      ? { id: sessionId }
      : method === 'POST' && path === `/session/${sessionId}/message`
        ? await allDelivered.then(() => response)
        : true;
    return { ok: true, status: 200, statusText: 'OK', json: async () => json } as unknown as Response;
  }) as unknown as typeof fetch;

  const spawned = fakeSpawn([]);
  const deps: AgentProcessDeps = { spawn: spawned.spawn, fetch: fetchImpl, resolvePath: async () => '/usr/bin', isDirectory: () => true, exists: () => true };
  const adapter = new OpenCodeAdapter(deps);
  const started = adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'plan read-only' });
  for (let i = 0; i < 50 && spawned.processes.length === 0; i++) await Promise.resolve();
  spawned.processes[0].emitStdout('opencode server listening on http://127.0.0.1:4096\n');
  await started;

  const events: AgentEvent[] = [];
  await adapter.send('the goal', (e) => events.push(e));
  adapter.dispose();
  return events;
}

function textOf(events: AgentEvent[], type: 'assistant_text' | 'assistant_text_delta'): string {
  return events.flatMap((e) => (e.type === type ? [e.text] : [])).join('');
}

describe('OpenCodeAdapter — recorded event stream', () => {
  it('streams the reply as deltas that add up to the settled text', async () => {
    const events = await replay('prose');

    const final = 'math.ts exports a single `add` function (`(a, b) => a + b`).';
    expect(textOf(events, 'assistant_text_delta')).toBe(final);
    expect(textOf(events, 'assistant_text')).toBe(final);
  });

  it('never streams the echoed user message as reply text', async () => {
    const events = await replay('prose');

    // The recorded prompt, which the server replays as a text part of the user message.
    const prompt = 'In two short sentences, what does math.ts export? Read it first.';
    const replyText = textOf(events, 'assistant_text_delta') + textOf(events, 'assistant_text');
    expect(replyText).not.toContain('math.ts export?');
    expect(events.some((e) => 'text' in e && e.text.includes(prompt))).toBe(false);
  });

  it('streams reasoning from an earlier model call that the settled response never holds', async () => {
    const events = await replay('prose');

    const reasoning = 'The user wants to know what math.ts exports. Let me find and read it.';
    const deltas = events.flatMap((e) => (e.type === 'thinking_delta' ? [e.text] : [])).join('');
    expect(deltas).toBe(reasoning);
    expect(events).toContainEqual({ type: 'thinking', text: reasoning, subagentId: undefined });
  });

  it('reports every model call of the turn once, with the runner-reported cost', async () => {
    const events = await replay('prose');

    // One record per assistant message. Each recorded `tokens.total` equals
    // inputTokens + outputTokens below: 13889, 14099, 14257.
    expect(events.filter((e) => e.type === 'usage')).toEqual([
      { type: 'usage', record: { source: 'opencode', model: 'opencode-go/deepseek-v4-flash', inputTokens: 13825, outputTokens: 64, cachedInputTokens: 1792, reportedCost: { amount: 0.001848726, currency: 'USD' } } },
      { type: 'usage', record: { source: 'opencode', model: 'opencode-go/deepseek-v4-flash', inputTokens: 13977, outputTokens: 122, cachedInputTokens: 13824, reportedCost: { amount: 0.000137622, currency: 'USD' } } },
      { type: 'usage', record: { source: 'opencode', model: 'opencode-go/deepseek-v4-flash', inputTokens: 14234, outputTokens: 23, cachedInputTokens: 14080, reportedCost: { amount: 0.00007914, currency: 'USD' } } },
    ]);
  });

  it('counts cache writes as prompt tokens that were not served from cache', async () => {
    const events = await replay('cache-write');

    // Recorded: input 3, cache.write 12147, output 23, total 12173.
    expect(events.filter((e) => e.type === 'usage')).toEqual([
      { type: 'usage', record: { source: 'opencode', model: 'opencode-go/gpt-5.6-luna', inputTokens: 12150, outputTokens: 23, cachedInputTokens: 0, reportedCost: { amount: 0.00306495, currency: 'USD' } } },
    ]);
  });

  it('counts reasoning as output and leaves a reported cost of 0 unreported', async () => {
    const events = await replay('free-model');

    // Recorded: output 0, reasoning 127, cost 0 on a free model.
    expect(events.filter((e) => e.type === 'usage')).toEqual([
      { type: 'usage', record: { source: 'opencode', model: 'opencode/nemotron-3.5-lightning-free', inputTokens: 14472, outputTokens: 127, cachedInputTokens: 0 } },
    ]);
    expect(textOf(events, 'assistant_text')).toBe('Hello there friend');
  });

  it('unwraps a read tool result from its <path>/<content> envelope', async () => {
    const events = await replay('prose');

    const result = events.find((e) => e.type === 'tool_result' && e.name === 'read');
    expect(result).toMatchObject({
      output: '1: export const add = (a: number, b: number) => a + b;\n\n(End of file - total 1 lines)',
    });
  });

  // Recorded from `opencode serve` 1.18.34: an `edit`, then a `write` of a new file.
  it('reports an edit as its diff\'s hunks and a new file as its added lines', async () => {
    const events = await replay('edit');

    const results = events.flatMap((e) => (e.type === 'tool_result' && (e.name === 'edit' || e.name === 'write') ? [[e.name, e.output]] : []));
    expect(results).toEqual(expect.arrayContaining([
      ['edit', '@@ -1,3 +1,3 @@\n export function sum(a, b) {\n-  return a - b;\n+  return a + b;\n }\n'],
      ['write', '+hi\n'],
    ]));
    expect(results).toHaveLength(2);
  });

  describe('a task call that runs a subagent in a child session', () => {
    const callId = 'call_81f9f8695fab49009d73c828';

    it('brackets the child session between subagent_started and subagent_finished', async () => {
      const events = await replay('subagent');

      const started = events.findIndex((e) => e.type === 'subagent_started');
      const finished = events.findIndex((e) => e.type === 'subagent_finished');
      expect(events[started]).toEqual({ type: 'subagent_started', subagentId: callId, brief: 'Read math.ts and list exports', model: 'opencode-go/deepseek-v4-flash' });
      const finish = events[finished];
      expect(finish).toMatchObject({ type: 'subagent_finished', subagentId: callId, outcome: 'done' });
      expect(finish.type === 'subagent_finished' && finish.digest).toMatch(/^Found at `\/repo\/math\.ts`/);
      expect(finish.type === 'subagent_finished' && finish.digest).not.toContain('<task');

      const tagged = events.flatMap((e, i) => ('subagentId' in e && e.subagentId === callId && e.type !== 'subagent_started' && e.type !== 'subagent_finished' ? [i] : []));
      expect(tagged.length).toBeGreaterThan(0);
      expect(tagged.every((i) => i > started && i < finished)).toBe(true);
    });

    it('tags the child session’s steps and keeps the planner’s own untagged', async () => {
      const events = await replay('subagent');

      const calls = events.flatMap((e) => (e.type === 'tool_call' ? [[e.name, e.subagentId]] : []));
      expect(calls).toEqual([['task', undefined], ['glob', callId], ['read', callId]]);
      const results = events.flatMap((e) => (e.type === 'tool_result' ? [[e.name, e.subagentId]] : []));
      expect(results).toEqual([['glob', callId], ['read', callId], ['task', undefined]]);
      expect(events).toContainEqual({ type: 'thinking', text: 'Let me find the file math.ts using glob.', subagentId: callId });
    });

    it('never lets the subagent’s words into the reply', async () => {
      const events = await replay('subagent');

      const final = '`math.ts` exports a single function `add(a: number, b: number): number`.';
      expect(textOf(events, 'assistant_text')).toBe(final);
      expect(textOf(events, 'assistant_text_delta')).toBe(final);
    });

    it('attributes the child session’s usage to the subagent', async () => {
      const events = await replay('subagent');

      const usage = events.flatMap((e) => (e.type === 'usage' ? [[e.record.subagentId, e.record.inputTokens, e.record.outputTokens]] : []));
      // Child totals 4780, 4990, 5260; the planner's 14067 and 14272.
      expect(usage).toEqual([
        [callId, 4723, 57],
        [callId, 4868, 122],
        [callId, 5125, 135],
        [undefined, 13830, 237],
        [undefined, 14250, 22],
      ]);
    });
  });
});
