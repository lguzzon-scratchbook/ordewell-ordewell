import { describe, it, expect } from 'vitest';
import { EMPTY_TASK_LOG, reduceTaskLog, replayTaskLog } from '../taskLog';
import type { TaskLogEvent } from '../../models/TaskLog';
import type { SubagentBlock, ToolBlock } from '../blocks';
import { unkeyed } from './helpers';

const start: TaskLogEvent = { type: 'turn_start', message: 'Do the task' };

describe('reduceTaskLog', () => {
  it('opens a turn with the message it delivers', () => {
    const view = replayTaskLog([start]);
    expect(view.working).toBe(true);
    expect(unkeyed(view.blocks)).toEqual([{ type: 'message', role: 'user', text: 'Do the task', streaming: false }]);
  });

  it('opens a turn the runner started itself without inventing a user message', () => {
    const view = replayTaskLog([{ type: 'turn_start', message: '' }, { type: 'text', text: 'FINISHED' }]);
    expect(view.working).toBe(true);
    expect(unkeyed(view.blocks)).toEqual([{ type: 'message', role: 'agent', text: 'FINISHED', streaming: false }]);
  });

  it('streams the agent’s text and lets the whole block replace it', () => {
    const streaming = replayTaskLog([start, { type: 'text_delta', text: 'Look' }, { type: 'text_delta', text: 'ing' }]);
    expect(unkeyed(streaming.blocks).at(-1)).toEqual({ type: 'message', role: 'agent', text: 'Looking', streaming: true });

    const settled = replayTaskLog([{ type: 'text', text: 'Looking around.' }], streaming);
    expect(unkeyed(settled.blocks)).toEqual([
      { type: 'message', role: 'user', text: 'Do the task', streaming: false },
      { type: 'message', role: 'agent', text: 'Looking around.', streaming: false },
    ]);
  });

  it('replaces a run whose block was already sealed by a later call, rather than repeating it', () => {
    const view = replayTaskLog([
      start,
      { type: 'text_delta', text: 'Checking' },
      { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"ls"}' },
      { type: 'text', text: 'Checking the tree.' },
    ]);
    expect(view.blocks.filter((b) => b.type === 'message' && b.role === 'agent')).toHaveLength(1);
    expect(view.blocks[1]).toMatchObject({ type: 'message', text: 'Checking the tree.', streaming: false });
  });

  it('starts a later text block of the turn as its own block, without the paragraph break that joins them', () => {
    const view = replayTaskLog([
      start,
      { type: 'text', text: 'First.' },
      { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"ls"}' },
      { type: 'text_delta', text: '\n\n' },
      { type: 'text_delta', text: 'Second.' },
      { type: 'text', text: '\n\nSecond.' },
    ]);
    const agent = view.blocks.filter((b) => b.type === 'message' && b.role === 'agent');
    expect(agent.map((b) => b.type === 'message' && b.text)).toEqual(['First.', 'Second.']);
  });

  it('folds thinking deltas into one block that the whole thought replaces', () => {
    const view = replayTaskLog([
      start,
      { type: 'thinking_delta', text: 'Hmm, ' },
      { type: 'thinking_delta', text: 'the tests.' },
      { type: 'thinking', text: 'Hmm, the tests.' },
      { type: 'text', text: 'Running them.' },
    ]);
    expect(unkeyed(view.blocks).slice(1)).toEqual([
      { type: 'thinking', text: 'Hmm, the tests.', streaming: false },
      { type: 'message', role: 'agent', text: 'Running them.', streaming: false },
    ]);
  });

  it('shows a tool call with its arguments and settles it with its output', () => {
    const view = replayTaskLog([
      start,
      { type: 'tool_call', id: 'c1', name: 'Read', args: '{"file_path":"src/a.ts"}' },
      { type: 'tool_call', id: 'c2', name: 'Bash', args: '{"command":"npm test"}' },
      { type: 'tool_result', id: 'c2', output: 'FAIL\n1 failed', success: false },
      { type: 'tool_result', id: 'c1', output: 'export const a = 1;', success: true },
    ]);
    const tools = view.blocks.filter((b): b is ToolBlock => b.type === 'tool');
    expect(tools.map((t) => [t.headline.name, t.headline.keyArg, t.status, t.output, t.outputLineCount])).toEqual([
      ['Read', 'src/a.ts', 'ok', 'export const a = 1;', 1],
      ['Bash', 'npm test', 'error', 'FAIL\n1 failed', 2],
    ]);
    expect(tools[0].args).toBe('{"file_path":"src/a.ts"}');
  });

  it('counts the lines a file edit added and removed, whichever runner named the edit', () => {
    const hunk = '@@ -1,3 +1,3 @@\n export function sum(a, b) {\n-  return a - b;\n+  return a + b;\n }\n';
    const view = replayTaskLog([
      start,
      { type: 'tool_call', id: 'c1', name: 'Update', args: '{"path":"src/sum.ts"}' },
      { type: 'tool_result', id: 'c1', output: hunk, success: true },
      { type: 'tool_call', id: 'c2', name: 'Write', args: '{"file_path":"/repo/hello.txt"}' },
      { type: 'tool_result', id: 'c2', output: '+hi\n+there\n', success: true },
      { type: 'tool_call', id: 'c3', name: 'edit', args: '{"filePath":"/repo/b.ts"}' },
      { type: 'tool_result', id: 'c3', output: '-gone\n', success: true },
    ]);
    const tools = view.blocks.filter((b): b is ToolBlock => b.type === 'tool');
    expect(tools.map((t) => t.diff)).toEqual([{ added: 1, removed: 1 }, { added: 2, removed: 0 }, { added: 0, removed: 1 }]);
  });

  it('counts nothing for an edit that reported prose, failed, or a command that printed a diff', () => {
    const view = replayTaskLog([
      start,
      { type: 'tool_call', id: 'c1', name: 'Edit', args: '{"file_path":"/repo/a.ts"}' },
      { type: 'tool_result', id: 'c1', output: 'The file /repo/a.ts has been updated successfully.', success: true },
      { type: 'tool_call', id: 'c2', name: 'Update', args: '{"path":"a.ts"}' },
      { type: 'tool_result', id: 'c2', output: '-a\n+b\n', success: false },
      { type: 'tool_call', id: 'c3', name: 'Bash', args: '{"command":"git diff"}' },
      { type: 'tool_result', id: 'c3', output: '-a\n+b\n', success: true },
    ]);
    const tools = view.blocks.filter((b): b is ToolBlock => b.type === 'tool');
    expect(tools.map((t) => t.diff)).toEqual([undefined, undefined, undefined]);
  });

  it('nests a subagent’s calls and thinking under the call that started it', () => {
    const view = replayTaskLog([
      start,
      { type: 'tool_call', id: 'agent-1', name: 'Agent', args: '{"description":"Read the README","prompt":"…"}' },
      { type: 'subagent_started', subagentId: 'agent-1', brief: 'Read the README', model: 'haiku' },
      { type: 'thinking', text: 'Opening it.', subagentId: 'agent-1' },
      { type: 'tool_call', id: 'r1', name: 'Read', args: '{"file_path":"README.md"}', subagentId: 'agent-1' },
      { type: 'tool_result', id: 'r1', output: 'hello', success: true, subagentId: 'agent-1' },
      { type: 'usage', record: { source: 'claude-code', inputTokens: 100, subagentId: 'agent-1' } },
      { type: 'subagent_finished', subagentId: 'agent-1', outcome: 'done', digest: 'It says hello.' },
      { type: 'tool_result', id: 'agent-1', output: 'It says hello.', success: true },
    ]);
    const subagents = view.blocks.filter((b): b is SubagentBlock => b.type === 'subagent');
    expect(subagents).toHaveLength(1);
    const [agent] = subagents;
    expect(agent).toMatchObject({ subagentId: 'agent-1', toolCallId: 'agent-1', brief: 'Read the README', model: 'haiku', status: 'done', digest: 'It says hello.', usage: { inputTokens: 100 } });
    expect(agent.children.map((c) => c.type)).toEqual(['thinking', 'tool']);
    expect(agent.children[1]).toMatchObject({ type: 'tool', headline: { name: 'Read', keyArg: 'README.md' }, status: 'ok', output: 'hello' });
    expect(view.blocks.some((b) => b.type === 'tool')).toBe(false);
  });

  it('keeps one usage line, last, over everything the runner reported', () => {
    const view = replayTaskLog([
      start,
      { type: 'usage', record: { source: 'claude-code', inputTokens: 1000, outputTokens: 50, contextWindow: 200_000 } },
      { type: 'text', text: 'Done.' },
      { type: 'usage', record: { source: 'claude-code', inputTokens: 1200, outputTokens: 20, reportedCost: { amount: 0.01, currency: 'USD' } } },
    ]);
    const last = view.blocks.at(-1);
    expect(view.blocks.filter((b) => b.type === 'usage')).toHaveLength(1);
    expect(last).toMatchObject({
      type: 'usage',
      totals: { inputTokens: 2200, outputTokens: 70, reportedCost: { USD: 0.01 } },
      contextFill: { usedTokens: 1200, windowTokens: 200_000 },
    });
  });

  it('draws no usage line for a report of nothing', () => {
    const view = replayTaskLog([start, { type: 'usage', record: { source: 'claude-code' } }]);
    expect(view.blocks.some((b) => b.type === 'usage')).toBe(false);
  });

  it('closes an interrupted turn: calls left unanswered and running subagents say they were cut short', () => {
    const view = replayTaskLog([
      start,
      { type: 'text_delta', text: 'Working' },
      { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"sleep 100"}' },
      { type: 'subagent_started', subagentId: 'sa', brief: 'Look around' },
      { type: 'turn_end', reason: 'interrupted' },
    ]);
    expect(view.working).toBe(false);
    expect(view.lastTurnEnd).toBe('interrupted');
    expect(view.blocks.find((b) => b.type === 'tool')).toMatchObject({ status: 'interrupted' });
    expect(view.blocks.find((b) => b.type === 'subagent')).toMatchObject({ status: 'stopped' });
    expect(view.blocks.some((b) => (b.type === 'message' || b.type === 'thinking') && b.streaming)).toBe(false);
    expect(view.blocks.at(-1)).toMatchObject({ type: 'message', role: 'system', text: 'Interrupted.' });
  });

  it('ends a normal turn with nothing streaming and nothing marked as cut', () => {
    const view = replayTaskLog([start, { type: 'text_delta', text: 'Done' }, { type: 'turn_end', reason: 'completed' }]);
    expect(view.lastTurnEnd).toBe('completed');
    expect(view.blocks.at(-1)).toMatchObject({ role: 'agent', text: 'Done', streaming: false });
  });

  it('shows a failed turn’s own words', () => {
    const view = replayTaskLog([start, { type: 'error', message: 'Claude Code ended the turn: error_max_turns' }, { type: 'turn_end', reason: 'failed' }]);
    expect(view.blocks.at(-1)).toMatchObject({ type: 'message', role: 'error', text: 'Claude Code ended the turn: error_max_turns' });
  });

  it('holds queued messages beside the blocks until a turn delivers them, and lets one be taken back', () => {
    const queued = replayTaskLog([
      start,
      { type: 'message_queued', messageId: 'msg-1', text: 'also add tests' },
      { type: 'message_queued', messageId: 'msg-2', text: 'and docs' },
    ]);
    expect(queued.queued).toEqual([{ id: 'msg-1', text: 'also add tests' }, { id: 'msg-2', text: 'and docs' }]);

    const removed = reduceTaskLog(queued, { type: 'message_removed', messageId: 'msg-2' });
    expect(removed.queued).toEqual([{ id: 'msg-1', text: 'also add tests' }]);

    const delivered = replayTaskLog([
      { type: 'turn_end', reason: 'completed' },
      { type: 'turn_start', message: 'also add tests', messageId: 'msg-1' },
    ], removed);
    expect(delivered.queued).toEqual([]);
    expect(delivered.working).toBe(true);
    expect(delivered.blocks.at(-1)).toMatchObject({ type: 'message', role: 'user', text: 'also add tests' });
  });

  it('puts a runner\'s tool request after the call it is for, and settles it with the answer', () => {
    const call: TaskLogEvent = { type: 'tool_call', id: 'toolu_1', name: 'Bash', args: '{"command":"npm test"}' };
    const asked = replayTaskLog([
      start, call,
      { type: 'approval_requested', approvalId: 'ap-1', tool: 'Bash', args: '{"command":"npm test"}', allowForTask: true, toolCallId: 'toolu_1' },
    ]);
    expect(unkeyed(asked.blocks).slice(1)).toEqual([
      expect.objectContaining({ type: 'tool', toolCallId: 'toolu_1', status: 'pending' }),
      { type: 'approval', approvalId: 'ap-1', kind: 'runner_tool', subject: 'Bash(npm test)', scope: 'Bash', status: 'pending', allowForTask: true, toolCallId: 'toolu_1' },
    ]);

    const allowed = replayTaskLog([{ type: 'approval_decided', approvalId: 'ap-1', decision: 'allowForTask' }], asked);
    expect(allowed.blocks.find((b) => b.type === 'approval')).toMatchObject({ status: 'granted', decidedBy: 'asked', forTask: true });
    expect(allowed.blocks[1]).toBe(asked.blocks[1]);
  });

  it('settles a denial with its note, and a withdrawn request as withdrawn', () => {
    const ask = (approvalId: string): TaskLogEvent => ({ type: 'approval_requested', approvalId, tool: 'Write', args: '{"file_path":"/repo/a.txt"}', allowForTask: false });
    const view = replayTaskLog([
      start, ask('ap-1'), ask('ap-2'),
      { type: 'approval_decided', approvalId: 'ap-1', decision: 'deny', note: 'use notes/' },
      { type: 'approval_withdrawn', approvalId: 'ap-2' },
    ]);
    const approvals = view.blocks.filter((b) => b.type === 'approval');
    expect(approvals).toEqual([
      expect.objectContaining({ approvalId: 'ap-1', subject: 'Write(/repo/a.txt)', status: 'denied', note: 'use notes/' }),
      expect.objectContaining({ approvalId: 'ap-2', status: 'withdrawn' }),
    ]);
    expect(approvals[0]).not.toHaveProperty('forTask');
  });

  it('takes the first answer to a request and ignores a repeated request', () => {
    const asked = replayTaskLog([start, { type: 'approval_requested', approvalId: 'ap-1', tool: 'Bash', args: '{}', allowForTask: false }]);
    const decided = replayTaskLog([{ type: 'approval_decided', approvalId: 'ap-1', decision: 'allow' }], asked);
    expect(reduceTaskLog(decided, { type: 'approval_withdrawn', approvalId: 'ap-1' })).toBe(decided);
    expect(reduceTaskLog(decided, { type: 'approval_requested', approvalId: 'ap-1', tool: 'Bash', args: '{}', allowForTask: false })).toBe(decided);
  });

  it('returns the view itself for an event that changes nothing, including one it does not know', () => {
    const view = replayTaskLog([start]);
    expect(reduceTaskLog(view, { type: 'message_removed', messageId: 'nope' })).toBe(view);
    const later = JSON.parse('{"type":"runner_approval","id":"x"}') as TaskLogEvent;
    expect(reduceTaskLog(view, later)).toBe(view);
  });

  it('keeps the identity of blocks an event does not touch', () => {
    const view = replayTaskLog([start, { type: 'text_delta', text: 'a' }]);
    const next = reduceTaskLog(view, { type: 'text_delta', text: 'b' });
    expect(next.blocks[0]).toBe(view.blocks[0]);
  });

  it('starts from nothing', () => {
    expect(EMPTY_TASK_LOG).toMatchObject({ blocks: [], queued: [], working: false });
  });
});

describe('reduceTaskLog with messages read mid-turn (ADR-0023)', () => {
  const handedOver = replayTaskLog([
    start,
    { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"sleep 20"}' },
    { type: 'message_queued', messageId: 'msg-1', text: 'use Postgres' },
    { type: 'message_queued', messageId: 'msg-2', text: 'and docs' },
    { type: 'message_handed_over', messageId: 'msg-1' },
  ]);

  it('marks the message the runner has, leaving the rest queued', () => {
    expect(handedOver.queued).toEqual([{ id: 'msg-1', text: 'use Postgres', handedOver: true }, { id: 'msg-2', text: 'and docs' }]);
    expect(reduceTaskLog(handedOver, { type: 'message_handed_over', messageId: 'msg-1' })).toBe(handedOver);
    expect(reduceTaskLog(handedOver, { type: 'message_handed_over', messageId: 'nope' })).toBe(handedOver);
  });

  it('shows the message in the transcript where the runner read it, between the steps around it, and drops it from the queue', () => {
    const view = replayTaskLog([
      { type: 'text_delta', text: 'Waiting on the sleep' },
      { type: 'tool_result', id: 'c1', output: '', success: true },
      { type: 'message_delivered', messageId: 'msg-1', text: 'use Postgres' },
      { type: 'text_delta', text: 'Switching.' },
    ], handedOver);

    expect(view.queued).toEqual([{ id: 'msg-2', text: 'and docs' }]);
    expect(view.working).toBe(true);
    const shown = view.blocks.map((b) => (b.type === 'message' ? `${b.role}:${b.text}${b.streaming ? '…' : ''}` : b.type));
    expect(shown).toEqual(['user:Do the task', 'tool', 'agent:Waiting on the sleep', 'user:use Postgres', 'agent:Switching.…']);
  });

  it('puts a message the runner let go of back in the queue, removable again', () => {
    const requeued = reduceTaskLog(handedOver, { type: 'message_queued', messageId: 'msg-1', text: 'use Postgres' });
    expect(requeued.queued).toEqual([{ id: 'msg-1', text: 'use Postgres' }, { id: 'msg-2', text: 'and docs' }]);
    expect(reduceTaskLog(requeued, { type: 'message_queued', messageId: 'msg-1', text: 'use Postgres' })).toBe(requeued);
  });
});
