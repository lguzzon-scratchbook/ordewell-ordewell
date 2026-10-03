import { describe, it, expect } from 'vitest';
import { coalesceTaskLog, digestTaskLog, toTaskLogEvent, trimToolOutput, type TaskLogEvent } from '../TaskLog';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('trimToolOutput', () => {
  it('keeps a short result whole', () => {
    expect(trimToolOutput(lines(100))).toEqual({ output: lines(100) });
  });

  it('keeps the head and tail of a long result and counts what it left out', () => {
    const { output, omittedLines } = trimToolOutput(lines(1000));
    const kept = output.split('\n');
    expect(omittedLines).toBe(900);
    expect(kept.slice(0, 2)).toEqual(['line 1', 'line 2']);
    expect(kept[60]).toBe('… 900 lines omitted …');
    expect(kept[kept.length - 1]).toBe('line 1000');
    expect(kept).toHaveLength(101);
  });

  it('cuts a single enormous line, which no line count would catch', () => {
    const { output, omittedLines } = trimToolOutput('x'.repeat(50_000));
    expect(omittedLines).toBeUndefined();
    expect(output.length).toBeLessThan(2100);
    expect(output.endsWith('…')).toBe(true);
  });
});

describe('toTaskLogEvent', () => {
  it('keeps a call’s arguments as JSON and its subagent', () => {
    expect(toTaskLogEvent({ type: 'tool_call', id: 'c1', name: 'Read', args: { file_path: 'a.ts' }, subagentId: 'sa' }))
      .toEqual({ type: 'tool_call', id: 'c1', name: 'Read', args: '{"file_path":"a.ts"}', subagentId: 'sa' });
  });

  it('trims a long result on the way in, so the file and the live stream carry the same text', () => {
    const event = toTaskLogEvent({ type: 'tool_result', id: 'c1', name: '', output: lines(500), success: true });
    expect(event).toMatchObject({ type: 'tool_result', id: 'c1', success: true, omittedLines: 400 });
  });

  it('names the queued message a turn delivers', () => {
    expect(toTaskLogEvent({ type: 'turn_start', text: 'also add tests', messageId: 'msg-2' }))
      .toEqual({ type: 'turn_start', message: 'also add tests', messageId: 'msg-2' });
    expect(toTaskLogEvent({ type: 'turn_start', text: 'Do the task' })).toEqual({ type: 'turn_start', message: 'Do the task' });
  });

  it('keeps a runner\'s tool request, whether it offered a grant for the task, and the call it is for', () => {
    expect(toTaskLogEvent({
      type: 'permission_request', id: 'p1', name: 'Write', detail: '{"file_path":"a.txt"}', input: { file_path: 'a.txt' },
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], toolUseId: 'toolu_1',
    })).toEqual({ type: 'approval_requested', approvalId: 'p1', tool: 'Write', args: '{"file_path":"a.txt"}', allowForTask: true, toolCallId: 'toolu_1' });
    expect(toTaskLogEvent({ type: 'permission_request', id: 'p2', name: 'Bash', detail: '{}', input: {}, suggestions: [] }))
      .toEqual({ type: 'approval_requested', approvalId: 'p2', tool: 'Bash', args: '{}', allowForTask: false });
  });

  it('keeps each answer, a denial with its note, and a request that went unanswered', () => {
    expect(toTaskLogEvent({ type: 'permission_decided', id: 'p1', decision: { decision: 'allowForTask' } }))
      .toEqual({ type: 'approval_decided', approvalId: 'p1', decision: 'allowForTask' });
    expect(toTaskLogEvent({ type: 'permission_decided', id: 'p1', decision: { decision: 'deny', note: 'not there' } }))
      .toEqual({ type: 'approval_decided', approvalId: 'p1', decision: 'deny', note: 'not there' });
    expect(toTaskLogEvent({ type: 'permission_withdrawn', id: 'p1' })).toEqual({ type: 'approval_withdrawn', approvalId: 'p1' });
  });

  it('leaves out background launches', () => {
    expect(toTaskLogEvent({ type: 'background_agent', id: 'a' })).toBeNull();
  });
});

describe('coalesceTaskLog', () => {
  it('merges runs of deltas and nothing else', () => {
    const events: TaskLogEvent[] = [
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'thinking_delta', text: 'a' },
      { type: 'thinking_delta', text: 'b', subagentId: 'sa' },
      { type: 'thinking_delta', text: 'c', subagentId: 'sa' },
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' again' },
    ];
    expect(coalesceTaskLog(events)).toEqual([
      { type: 'text_delta', text: 'Hello' },
      { type: 'thinking_delta', text: 'a' },
      { type: 'thinking_delta', text: 'bc', subagentId: 'sa' },
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' again' },
    ]);
  });
});

describe('digestTaskLog', () => {
  const call = (id: string, name: string, args: unknown): TaskLogEvent => ({ type: 'tool_call', id, name, args: JSON.stringify(args) });
  const result = (id: string, success: boolean): TaskLogEvent => ({ type: 'tool_result', id, output: 'ignored', success });

  it('lists each call with how it ended', () => {
    const digest = digestTaskLog([
      call('c1', 'Bash', { command: 'az group create -n rg-dev' }),
      result('c1', true),
      call('c2', 'Bash', { command: 'az deployment create' }),
      result('c2', false),
    ], 20);

    expect(digest).toBe([
      '- Bash {"command":"az group create -n rg-dev"} → ok',
      '- Bash {"command":"az deployment create"} → failed',
    ].join('\n'));
  });

  it('says so when the attempt ended inside a call, rather than calling it failed', () => {
    const digest = digestTaskLog([call('c1', 'Bash', { command: 'az pipelines run' })], 20);

    expect(digest).toBe('- Bash {"command":"az pipelines run"} → no result');
  });

  it('keeps only the last calls and counts the earlier ones it left out', () => {
    const events = ['a', 'b', 'c', 'd'].flatMap((x) => [call(x, 'Bash', { command: x }), result(x, true)]);

    expect(digestTaskLog(events, 2)).toBe([
      '… 2 earlier calls omitted …',
      '- Bash {"command":"c"} → ok',
      '- Bash {"command":"d"} → ok',
    ].join('\n'));
  });

  it('cuts a long call to one line', () => {
    const digest = digestTaskLog([call('c1', 'Write', { content: 'x'.repeat(500) }), result('c1', true)], 20);

    expect(digest).toBe(`- Write {"content":"${'x'.repeat(108)}… → ok`);
  });

  it('ends with the agent\'s last words and the error that stopped it', () => {
    const digest = digestTaskLog([
      call('c1', 'Bash', { command: 'az deployment create' }),
      result('c1', false),
      { type: 'text', text: 'The deployment failed on quota.' },
      { type: 'error', message: 'rate limited' },
    ], 20);

    expect(digest).toBe([
      '- Bash {"command":"az deployment create"} → failed',
      '',
      'Its last message:',
      '  The deployment failed on quota.',
      '',
      'It stopped with an error: rate limited',
    ].join('\n'));
  });

  it('keeps the end of a long last message, where the agent says how it stopped', () => {
    const digest = digestTaskLog([{ type: 'text', text: `${'a'.repeat(5000)} then it stopped` }], 20);

    expect(digest).toBe(['Its last message:', `  …${'a'.repeat(984)} then it stopped`].join('\n'));
  });
});
