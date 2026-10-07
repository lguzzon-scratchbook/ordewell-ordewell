import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionMessage } from '../SessionMessage';
import { makeSession, fakeConfig } from './sessionTestKit';
import { planJson } from './harnessTestKit';

const createSpy = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createSpy } };
  },
}));

import { OpenAiService } from '../OpenAiService';
import { PlannerTurnStoppedError } from '../PlannerConversation';

/**
 * The OpenAI-compatible planner streaming a turn to the surfaces (#48), end to
 * end: provider chunks in, Session broadcasts out. Only the HTTP client is
 * faked — each `create` call is one scripted stream.
 */

type Chunk = { choices: { delta: Record<string, unknown>; finish_reason?: string }[] };

const content = (text: string): Chunk => ({ choices: [{ delta: { content: text } }] });
const reasoning = (text: string): Chunk => ({ choices: [{ delta: { reasoning: text } }] });
const toolCall = (id: string, name: string, args: Record<string, unknown>): Chunk => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }],
});

function scriptCalls(...calls: Chunk[][]): void {
  for (const chunks of calls) {
    createSpy.mockImplementationOnce(async () => (async function* () { yield* chunks; })());
  }
}

type Streamed = Exclude<SessionMessage, { type: 'plan_generated' | 'status_update' }>;

function openAiSession() {
  const sent: SessionMessage[] = [];
  const config = fakeConfig({
    aiProvider: 'openai',
    orchestratorModel: 'openai:gpt-4o',
    researchSubagentModel: 'openai:gpt-4o-mini',
    getProviderBaseUrl: () => 'https://api.openai.com/v1',
    getProviderApiKey: () => 'sk-test',
  });
  const ai = new OpenAiService(config);
  // Bound one by one: the session kit spreads a partial fake, which would drop a class's prototype methods.
  const session = makeSession({
    config,
    broadcast: (msg) => sent.push(msg),
    aiService: {
      startConversation: (req) => ai.startConversation(req),
      continueConversation: (message, onProgress, signal) => ai.continueConversation(message, onProgress, signal),
      hasActiveConversation: () => ai.hasActiveConversation(),
      reset: () => ai.reset(),
    },
  });
  const streamed = () => sent
    .filter((m): m is Streamed => m.type !== 'plan_generated' && m.type !== 'status_update')
    .map((m) => (m.type === 'planner_message' ? { ...m, timestamp: '<now>' } : m));
  return { session, streamed };
}

function turnIdOf(messages: unknown[]): string {
  return (messages[0] as { turnId: string }).turnId;
}

describe('OpenAI planner reply stream', () => {
  beforeEach(() => createSpy.mockReset());

  it('streams each API call as its own segment, text before a tool call included, all under one turn', async () => {
    scriptCalls(
      [reasoning('look first'), content('Let me look.'), toolCall('c1', 'read_file', { path: 'a.ts' })],
      [content('Which '), content('store?')],
    );
    const { session, streamed } = openAiSession();

    await session.startPlanning('add persistence', ['claude-code']);

    const sent = streamed();
    const turnId = turnIdOf(sent);
    const segments = [...new Set(sent.flatMap((m) => ('segmentId' in m && m.segmentId ? [m.segmentId] : [])))];
    expect(segments).toHaveLength(2);
    const [before, after] = segments;
    expect(sent.map((m) => ({ ...m, ...('step' in m ? { step: '<step>' } : {}) }))).toEqual([
      { type: 'planner_turn_started', turnId, prompt: 'add persistence' },
      { type: 'planner_thinking_delta', turnId, segmentId: before, text: 'look first' },
      { type: 'planner_text_delta', turnId, segmentId: before, text: 'Let me look.' },
      { type: 'research_step', turnId, tool: 'read_file', args: '{"path":"a.ts"}', toolCallId: 'c1' },
      { type: 'research_step_done', turnId, step: '<step>' },
      { type: 'planner_text_delta', turnId, segmentId: after, text: 'Which ' },
      { type: 'planner_text_delta', turnId, segmentId: after, text: 'store?' },
      { type: 'planner_message', content: 'Which store?', timestamp: '<now>', turnId },
      { type: 'planner_turn_ended', turnId, outcome: 'message' },
    ]);
  });

  it('streams a JSON plan only to the building-plan display', async () => {
    const plan = planJson();
    scriptCalls([content(plan.slice(0, 9)), content(plan.slice(9, 40)), content(plan.slice(40))]);
    const { session, streamed } = openAiSession();

    await session.startPlanning('add persistence', ['claude-code']);

    const sent = streamed();
    const turnId = turnIdOf(sent);
    expect(sent.filter((m) => m.type === 'planner_text_delta')).toEqual([]);
    expect(sent.flatMap((m) => (m.type === 'plan_token' ? [m.token] : [])).join('')).toBe(plan);
    expect(sent.filter((m) => m.type === 'plan_token').every((m) => 'turnId' in m && m.turnId === turnId)).toBe(true);
    expect(sent[sent.length - 1]).toEqual({ type: 'planner_turn_ended', turnId, outcome: 'plan' });
  });

  it('streams a fenced taskOps envelope only to the building-plan display', async () => {
    const ops = '```json\n{"taskOps":[{"op":"update","taskId":"#1","changes":{"title":"Add the other thing"}}]}\n```';
    // Split inside the fence and its tag, where the route is still undecided.
    const cuts = [0, 2, 5, 14, ops.length];
    scriptCalls([content(planJson())], cuts.slice(1).map((end, i) => content(ops.slice(cuts[i], end))));
    const { session, streamed } = openAiSession();
    await session.startPlanning('add persistence', ['claude-code']);
    const firstTurn = streamed().length;

    await session.continueConversation('rename task 1');

    const sent = streamed().slice(firstTurn);
    const turnId = turnIdOf(sent);
    expect(sent.filter((m) => m.type === 'planner_text_delta')).toEqual([]);
    expect(sent.flatMap((m) => (m.type === 'plan_token' ? [m.token] : [])).join('')).toBe(ops);
    expect(sent.at(-2)).toMatchObject({ type: 'planner_message', content: expect.stringContaining('Tasks updated'), turnId });
    expect(sent.at(-1)).toEqual({ type: 'planner_turn_ended', turnId, outcome: 'task_ops' });
  });

  it('takes back the text of an attempt a JSON repair discards, then streams the retry', async () => {
    // Balanced and tasks-keyed, so a botched plan — but missing required fields.
    const broken = '{"tasks":[{"id":"t1","order":1,"title":"A","description":"d","type":"ai","dependencies":[],"subtasks":[]}]}';
    scriptCalls([content('Here is the plan: '), content(broken)], [content(planJson())]);
    const { session, streamed } = openAiSession();

    await session.startPlanning('add persistence', ['claude-code']);

    const sent = streamed();
    const turnId = turnIdOf(sent);
    const discarded = (sent[1] as { segmentId: string }).segmentId;
    expect(sent.slice(0, 4)).toEqual([
      { type: 'planner_turn_started', turnId, prompt: 'add persistence' },
      { type: 'planner_text_delta', turnId, segmentId: discarded, text: 'Here is the plan: ' },
      { type: 'planner_text_delta', turnId, segmentId: discarded, text: broken },
      { type: 'planner_text_retracted', turnId, segmentId: discarded },
    ]);
    expect(sent.slice(4, -1).map((m) => m.type)).toEqual(['plan_token']);
    expect(sent.at(-1)).toEqual({ type: 'planner_turn_ended', turnId, outcome: 'plan' });
  });

  it('takes back the text of task edits the plan rejected before the corrected edits stream', async () => {
    const rejected = '{"taskOps":[{"op":"update","taskId":"#9","changes":{"title":"Nothing there"}}]}';
    const corrected = '{"taskOps":[{"op":"update","taskId":"#1","changes":{"title":"Add the other thing"}}]}';
    scriptCalls([content(planJson())], [content('Renaming it now. '), content(rejected)], [content(corrected)]);
    const { session, streamed } = openAiSession();
    await session.startPlanning('add persistence', ['claude-code']);
    const firstTurn = streamed().length;

    await session.continueConversation('rename task 1');

    const sent = streamed().slice(firstTurn);
    const turnId = turnIdOf(sent);
    const discarded = (sent[1] as { segmentId: string }).segmentId;
    expect(sent.slice(1, 4)).toEqual([
      { type: 'planner_text_delta', turnId, segmentId: discarded, text: 'Renaming it now. ' },
      { type: 'planner_text_delta', turnId, segmentId: discarded, text: rejected },
      { type: 'planner_text_retracted', turnId, segmentId: discarded },
    ]);
    expect(sent.slice(4).map((m) => m.type)).toEqual(['plan_token', 'planner_message', 'planner_turn_ended']);
    expect(sent.at(-1)).toEqual({ type: 'planner_turn_ended', turnId, outcome: 'task_ops' });
  });

  it('ends a turn stopped mid-stream as stopped, though the client throws and the turn rolls back', async () => {
    const stop = new AbortController();
    scriptCalls([content('Which store?')]);
    createSpy.mockImplementationOnce(async () => (async function* () {
      yield content('Postgres, ');
      stop.abort();
      throw new Error('Request was aborted.');
    })());
    const { session, streamed } = openAiSession();
    await session.startPlanning('add persistence', ['claude-code']);
    const firstTurn = streamed().length;

    await expect(session.continueConversation('postgres', { signal: stop.signal })).rejects.toThrow(PlannerTurnStoppedError);

    const sent = streamed().slice(firstTurn);
    const turnId = turnIdOf(sent);
    expect(sent.map((m) => m.type)).toEqual(['planner_turn_started', 'planner_text_delta', 'planner_turn_ended']);
    expect(sent.at(-1)).toEqual({ type: 'planner_turn_ended', turnId, outcome: 'stopped' });
    expect(session.planState?.conversationHistory?.map((m) => m.content)).toEqual(['add persistence', 'Which store?']);
  });

  it('ends a turn whose backend fails as an error', async () => {
    createSpy.mockRejectedValueOnce(new Error('503 upstream unavailable'));
    const { session, streamed } = openAiSession();

    await expect(session.startPlanning('add persistence', ['claude-code'])).rejects.toThrow('503');

    const sent = streamed();
    expect(sent.at(-1)).toEqual({ type: 'planner_turn_ended', turnId: turnIdOf(sent), outcome: 'error' });
  });

  it('keeps a research subagent\'s own text and thinking out of the reply', async () => {
    scriptCalls(
      [toolCall('c1', 'spawn_research_agent', { prompt: 'find the cache' })],
      [reasoning('grep first'), content('The cache lives in src/cache.ts.')],
      [content('It is in src/cache.ts.')],
    );
    const { session, streamed } = openAiSession();

    await session.startPlanning('where is the cache?', ['claude-code']);

    const sent = streamed();
    expect(sent.flatMap((m) => (m.type === 'planner_text_delta' ? [m.text] : []))).toEqual(['It is in src/cache.ts.']);
    expect(sent.filter((m) => m.type === 'planner_thinking_delta')).toEqual([
      expect.objectContaining({ text: 'grep first', subagentId: expect.any(String) }),
    ]);
  });

  it('keeps a read the turn answers inside the same turn', async () => {
    scriptCalls(
      [content(planJson())],
      [content('{"taskQuery":{"tasks":["#1"]}}')],
      [content('Task 1 adds the thing.')],
    );
    const { session, streamed } = openAiSession();
    await session.startPlanning('add persistence', ['claude-code']);
    const firstTurn = streamed().length;

    await session.continueConversation('what does task 1 do?');

    const sent = streamed().slice(firstTurn);
    const turnId = turnIdOf(sent);
    expect(sent.filter((m) => m.type === 'planner_turn_started' || m.type === 'planner_turn_ended')).toHaveLength(2);
    expect(sent.every((m) => 'turnId' in m && m.turnId === turnId)).toBe(true);
    expect(sent.at(-2)).toMatchObject({ type: 'planner_message', content: 'Task 1 adds the thing.' });
  });
});

