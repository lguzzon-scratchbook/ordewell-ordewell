import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { ApprovalBlock, DisplayBlock, MessageBlock, SubagentBlock, ThinkingDisplayBlock, ToolBlock } from '@ordewell/core';
import ChatMessage, { CommandRow, ConversationBlocks, SubagentCard, ThinkingBlock, renderMarkdown } from '../ChatMessage';

const message = (over: Partial<MessageBlock>): MessageBlock => ({ type: 'message', id: 'm', role: 'planner', text: '', streaming: false, ...over });
const thinking = (over: Partial<ThinkingDisplayBlock> = {}): ThinkingDisplayBlock => ({
  type: 'thinking', id: 'th', text: 'First I read the config.\nThen the tests.', streaming: false, ...over,
});
const tool = (over: Partial<ToolBlock> = {}): ToolBlock => ({
  type: 'tool', id: 'tl', tool: 'bash', headline: { name: 'Bash', keyArg: 'ls -la' }, args: '{"command":"ls -la"}',
  status: 'ok', outcome: 'success', output: 'one\ntwo\nthree\nfour\nfive', outputLineCount: 5, ...over,
});
const subagent = (over: Partial<SubagentBlock> = {}): SubagentBlock => ({
  type: 'subagent', id: 'sa', subagentId: 'x', brief: 'explore the auth module', status: 'done',
  children: [tool({ id: 'c1', headline: { name: 'Read', keyArg: 'src/auth.ts' }, output: 'export {}', outputLineCount: 1 })],
  digest: 'Auth uses JWT.', ...over,
});

describe('ChatMessage', () => {
  it('shows the user\'s words as typed', () => {
    const { container } = render(<ChatMessage block={message({ role: 'user', text: 'use **JWT**' })} />);
    expect(container.querySelector('.chat-msg-user .chat-msg-content')!.textContent).toBe('use **JWT**');
  });

  it('renders a planner reply as markdown', () => {
    const { container } = render(<ChatMessage block={message({ text: 'Use **JWT** in `auth.ts`' })} />);
    expect(container.querySelector('.chat-msg-planner strong')!.textContent).toBe('JWT');
    expect(container.querySelector('.chat-msg-planner code')!.textContent).toBe('auth.ts');
  });

  it('renders a reply still streaming as markdown, marked live', () => {
    const { container } = render(<ChatMessage block={message({ text: 'Reading **the', streaming: true })} />);
    expect(container.querySelector('.chat-msg-planner.streaming .chat-msg-content')!.textContent).toBe('Reading **the');
    expect(container.querySelector('.chat-msg-cursor')).toBeTruthy();
  });

  it('shows a notice as a muted system line and an error as an error line', () => {
    const { container } = render(<>
      <ChatMessage block={message({ id: 'a', role: 'system', text: 'Approved: npm test' })} />
      <ChatMessage block={message({ id: 'b', role: 'error', text: 'Planner failed' })} />
    </>);
    expect(container.querySelector('.chat-msg-system')!.textContent).toBe('Approved: npm test');
    expect(container.querySelector('.chat-msg-error')!.textContent).toBe('Planner failed');
  });
});

describe('ThinkingBlock', () => {
  it('is one line when collapsed', () => {
    const { container } = render(<ThinkingBlock block={thinking()} expanded={false} />);
    expect(container.querySelector('.activity-think-head')!.textContent).toContain('Thinking');
    expect(container.querySelector('.activity-think-line')!.textContent).toBe('First I read the config.');
    expect(container.querySelector('.activity-think-pre')).toBeNull();
  });

  it('says it is still thinking while it streams', () => {
    const { container } = render(<ThinkingBlock block={thinking({ streaming: true })} expanded={false} />);
    expect(container.querySelector('.activity-think-head')!.textContent).toContain('Thinking…');
  });

  it('shows all of it when expanded', () => {
    const { container } = render(<ThinkingBlock block={thinking()} expanded />);
    expect(container.querySelector('.activity-think-pre')!.textContent).toBe('First I read the config.\nThen the tests.');
  });

  it('does not open on a click: detail is one switch for the whole conversation', () => {
    const { container } = render(<ThinkingBlock block={thinking()} expanded={false} />);
    fireEvent.click(container.querySelector('.activity-think')!);
    expect(container.querySelector('.activity-think-pre')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('CommandRow', () => {
  it('heads the row with the tool and its main argument, in monospace', () => {
    const { container } = render(<CommandRow block={tool()} expanded={false} />);
    const head = container.querySelector('code.cmd-row-head')!;
    expect(head.textContent).toBe('Bash(ls -la)');
  });

  it('previews three lines of output and counts the rest', () => {
    const { container } = render(<CommandRow block={tool()} expanded={false} />);
    expect(container.querySelector('.cmd-row-preview')!.textContent).toBe('one\ntwo\nthree');
    expect(container.querySelector('.cmd-row-more')!.textContent).toBe('+2 lines');
    expect(container.querySelector('.cmd-row-args')).toBeNull();
  });

  it('shows no count when the output fits', () => {
    const { container } = render(<CommandRow block={tool({ output: 'one\ntwo', outputLineCount: 2 })} expanded={false} />);
    expect(container.querySelector('.cmd-row-more')).toBeNull();
  });

  it('shows the full arguments and output when expanded', () => {
    const { container } = render(<CommandRow block={tool()} expanded />);
    expect(container.querySelector('.cmd-row-args')!.textContent).toBe('{\n  "command": "ls -la"\n}');
    expect(container.querySelector('.cmd-row-output')!.textContent).toBe('one\ntwo\nthree\nfour\nfive');
    expect(container.querySelector('.cmd-row-more')).toBeNull();
  });

  it('marks a pending call, and names an outcome that is not a plain success', () => {
    const { container } = render(<>
      <CommandRow block={tool({ id: 'a', status: 'pending', outcome: undefined, output: '', outputLineCount: 0 })} expanded={false} />
      <CommandRow block={tool({ id: 'b', status: 'denied', outcome: 'refused', output: 'Command refused', outputLineCount: 1 })} expanded={false} />
    </>);
    const rows = container.querySelectorAll('.cmd-row');
    expect(rows[0].getAttribute('data-status')).toBe('pending');
    expect(rows[1].getAttribute('data-status')).toBe('denied');
    expect(rows[1].querySelector('.cmd-row-outcome')!.textContent).toBe('refused');
  });

  it('does not open on a click', () => {
    const { container } = render(<CommandRow block={tool()} expanded={false} />);
    fireEvent.click(container.querySelector('.cmd-row-head')!);
    expect(container.querySelector('.cmd-row-output')).toBeNull();
  });

  it('lets a path argument give way from the left, keeping the whole path in its tooltip', () => {
    const path = '/home/dev/app/.ordewell/worktrees/3c3de77a/2-a-task/src/conversation/taskLog.ts';
    const { container } = render(<CommandRow block={tool({ headline: { name: 'Read', keyArg: path } })} expanded={false} />);
    const arg = container.querySelector('.cmd-row-arg')!;
    expect(arg.classList.contains('path')).toBe(true);
    expect(arg.getAttribute('title')).toBe(path);
    expect(container.querySelector('code.cmd-row-head')!.textContent).toBe(`Read(${path})`);
    const { container: command } = render(<CommandRow block={tool()} expanded={false} />);
    expect(command.querySelector('.cmd-row-arg')!.classList.contains('path')).toBe(false);
  });
});

describe('CommandRow for a file edit', () => {
  const SUM = '@@ -1,3 +1,3 @@\n export function sum(a, b) {\n-  return a - b;\n+  return a + b;\n }\n';
  const edit = (output = SUM, over: Partial<ToolBlock> = {}) => tool({
    tool: 'agent_tool', toolLabel: 'Update', headline: { name: 'Update', keyArg: 'src/sum.ts' }, args: '{"path":"src/sum.ts"}',
    output, outputLineCount: output.split('\n').length, diff: { added: 1, removed: 1 }, ...over,
  });
  const rows = (container: HTMLElement) => Array.from(container.querySelectorAll('.diff-line')).map((row) => [
    row.getAttribute('data-kind'), row.querySelector('.diff-num')!.textContent, row.querySelector('.diff-sign')!.textContent, row.querySelector('.diff-text')!.textContent,
  ]);

  it('says what the edit changed, then its lines numbered and marked, an addition and a removal told apart', () => {
    const { container } = render(<CommandRow block={edit()} expanded={false} />);
    expect(container.querySelector('.diff-summary')!.textContent).toBe('Added 1 line, removed 1 line');
    expect(rows(container)).toEqual([
      ['context', '1', ' ', 'export function sum(a, b) {'],
      ['removed', '2', '-', '  return a - b;'],
      ['added', '2', '+', '  return a + b;'],
      ['context', '3', ' ', '}'],
    ]);
    expect(container.querySelector('.cmd-row-preview')).toBeNull();
  });

  it('previews ten lines of a long diff and counts the rest, showing all of it when expanded', () => {
    const output = Array.from({ length: 30 }, (_, i) => `+line ${i + 1}`).join('\n');
    const block = edit(output, { diff: { added: 30, removed: 0 } });
    const { container } = render(<CommandRow block={block} expanded={false} />);
    expect(rows(container)).toHaveLength(10);
    expect(container.querySelector('.cmd-row-more')!.textContent).toBe('+20 lines');

    const { container: open } = render(<CommandRow block={block} expanded />);
    expect(rows(open)).toHaveLength(30);
    expect(open.querySelector('.cmd-row-more')).toBeNull();
    expect(open.querySelector('.cmd-row-output')).toBeNull();
  });

  it('marks the lines between two hunks', () => {
    const { container } = render(<CommandRow block={edit('@@ -1 +1 @@\n-a\n+A\n@@ -40 +40 @@\n-b\n+B\n')} expanded={false} />);
    expect(container.querySelectorAll('.diff-gap')).toHaveLength(1);
  });

  it('draws an edit that reported no diff as an ordinary row', () => {
    const { container } = render(<CommandRow block={edit('The file was updated.', { diff: undefined })} expanded={false} />);
    expect(container.querySelector('.diff-summary')).toBeNull();
    expect(container.querySelector('.cmd-row-preview')!.textContent).toBe('The file was updated.');
  });
});

describe('SubagentCard', () => {
  it('shows its brief, status and digest when collapsed, but not its steps', () => {
    const { container } = render(<SubagentCard block={subagent()} expanded={false} />);
    expect(container.querySelector('.subagent-card-brief')!.textContent).toBe('explore the auth module');
    expect(container.querySelector('.subagent-card-status')!.textContent).toBe('done');
    expect(container.querySelector('.subagent-card-digest')!.textContent).toBe('Auth uses JWT.');
    expect(container.querySelector('.subagent-card-steps')).toBeNull();
  });

  it('says a subagent is still running', () => {
    const { container } = render(<SubagentCard block={subagent({ status: 'running', digest: '' })} expanded={false} />);
    expect(container.querySelector('.subagent-card')!.getAttribute('data-status')).toBe('running');
    expect(container.querySelector('.subagent-card-status')!.textContent).toBe('running…');
    expect(container.querySelector('.subagent-card-digest')).toBeNull();
  });

  it('shows its nested steps, themselves expanded, when expanded', () => {
    const { container } = render(<SubagentCard block={subagent()} expanded />);
    const steps = container.querySelector('.subagent-card-steps')!;
    expect(steps.querySelector('code.cmd-row-head')!.textContent).toBe('Read(src/auth.ts)');
    expect(steps.querySelector('.cmd-row-output')!.textContent).toBe('export {}');
  });
});

describe('ConversationBlocks', () => {
  const blocks: DisplayBlock[] = [
    message({ id: 'u', role: 'user', text: 'add a parser' }),
    thinking({ id: 'th' }),
    tool({ id: 'tl' }),
    subagent({ id: 'sa' }),
    message({ id: 'p', text: 'Done.' }),
  ];

  it('draws every block in order', () => {
    const { container } = render(<ConversationBlocks blocks={blocks} detailAll={false} onShowPlan={() => {}} />);
    const kinds = Array.from(container.querySelector('.conversation')!.children).map((el) => el.className.split(' ')[0]);
    expect(kinds).toEqual(['chat-msg', 'activity-think', 'cmd-row', 'subagent-card', 'chat-msg']);
  });

  it('collapses every thinking, command and subagent block with detail off, and expands them all with it on', () => {
    const { container, rerender } = render(<ConversationBlocks blocks={blocks} detailAll={false} onShowPlan={() => {}} />);
    expect(container.querySelectorAll('.activity-think-pre, .cmd-row-output, .subagent-card-steps')).toHaveLength(0);

    rerender(<ConversationBlocks blocks={blocks} detailAll onShowPlan={() => {}} />);
    expect(container.querySelectorAll('.activity-think-pre')).toHaveLength(1);
    expect(container.querySelectorAll('.subagent-card-steps')).toHaveLength(1);
    // The top-level row and the one nested in the subagent.
    expect(container.querySelectorAll('.cmd-row-output')).toHaveLength(2);
  });

  it('opens the plan from a plan marker', () => {
    const onShowPlan = vi.fn();
    const { getByText } = render(
      <ConversationBlocks blocks={[{ type: 'plan', id: 'pl', status: 'generated', taskCount: 3, text: '' }]} detailAll={false} onShowPlan={onShowPlan} />,
    );
    fireEvent.click(getByText('Plan generated · 3 tasks'));
    expect(onShowPlan).toHaveBeenCalled();
  });

  it('says a plan is being built while it streams', () => {
    const { getByText } = render(
      <ConversationBlocks blocks={[{ type: 'plan', id: 'pl', status: 'building', text: '{"tasks":' }]} detailAll={false} onShowPlan={() => {}} />,
    );
    expect(getByText('Building plan…')).toBeTruthy();
  });

  it('marks an updated plan with its task count', () => {
    const { getByText } = render(
      <ConversationBlocks blocks={[{ type: 'plan', id: 'pl', status: 'updated', taskCount: 2, text: '' }]} detailAll={false} onShowPlan={() => {}} />,
    );
    expect(getByText('Plan updated · 2 tasks')).toBeTruthy();
  });
});

describe('approval cards (ADR-0018, A1)', () => {
  const card = (over: Partial<ApprovalBlock> = {}): ApprovalBlock => ({
    type: 'approval', id: 'ap', approvalId: 'ap-1', kind: 'runner_tool', subject: 'Write(/repo/a.txt)', scope: 'Write', status: 'pending', allowForTask: true, ...over,
  });

  function draw(block: ApprovalBlock) {
    const onAnswerApproval = vi.fn();
    const onResolveApproval = vi.fn();
    const view = render(<ConversationBlocks blocks={[block]} detailAll={false} onShowPlan={() => {}}
      onAnswerApproval={onAnswerApproval} onResolveApproval={onResolveApproval} />);
    return { ...view, onAnswerApproval, onResolveApproval };
  }

  it('answers a runner\'s request with the runner\'s own decisions, never the planner\'s yes/no', () => {
    const { getByText, onAnswerApproval, onResolveApproval } = draw(card());
    expect(getByText('Use a tool')).toBeTruthy();
    expect(getByText('Waiting for you')).toBeTruthy();

    fireEvent.click(getByText('Allow'));
    fireEvent.click(getByText('Allow for this task'));
    fireEvent.click(getByText('Deny'));

    expect(onAnswerApproval.mock.calls).toEqual([
      ['ap-1', { decision: 'allow' }],
      ['ap-1', { decision: 'allowForTask' }],
      // A blank note is no note: the agent is not handed an empty message.
      ['ap-1', { decision: 'deny' }],
    ]);
    expect(onResolveApproval).not.toHaveBeenCalled();
  });

  it('sends the typed note with a denial, trimmed', () => {
    const { getByText, getByPlaceholderText, onAnswerApproval } = draw(card());
    fireEvent.change(getByPlaceholderText(/Note to the agent/), { target: { value: '  use notes/ instead ' } });
    fireEvent.click(getByText('Deny'));
    expect(onAnswerApproval).toHaveBeenCalledWith('ap-1', { decision: 'deny', note: 'use notes/ instead' });
  });

  it('offers no grant for the task when the runner proposed none', () => {
    const { queryByText, getByText } = draw(card({ allowForTask: false }));
    expect(queryByText('Allow for this task')).toBeNull();
    expect(getByText('Allow')).toBeTruthy();
  });

  it.each<[Partial<ApprovalBlock>, string]>([
    [{ status: 'granted', decidedBy: 'asked' }, 'Approved'],
    [{ status: 'granted', decidedBy: 'asked', forTask: true }, 'Approved for this task'],
    [{ status: 'denied', decidedBy: 'asked', note: 'use notes/' }, 'Denied'],
    [{ status: 'withdrawn' }, 'Withdrawn'],
  ])('settles a runner card %o as "%s", with nothing left to press', (over, label) => {
    const { getByText, queryByText, container } = draw(card(over));
    expect(getByText(label)).toBeTruthy();
    expect(queryByText('Allow')).toBeNull();
    expect(queryByText('Deny')).toBeNull();
    expect(container.querySelector('.approval-card-note')).toBeNull();
    if (over.note) expect(getByText(`Note to the agent: ${over.note}`)).toBeTruthy();
  });

  it('keeps a planner\'s request on its own Allow/Deny card, answered yes or no', () => {
    const { getByText, queryByText, onAnswerApproval, onResolveApproval } = draw(card({
      kind: 'shell_command', subject: 'npm test', scope: 'npm test', allowForTask: undefined,
    }));
    expect(getByText('Run a command')).toBeTruthy();
    expect(queryByText('Allow for this task')).toBeNull();

    fireEvent.click(getByText('Allow'));
    fireEvent.click(getByText('Deny'));
    expect(onResolveApproval.mock.calls).toEqual([['ap-1', true], ['ap-1', false]]);
    expect(onAnswerApproval).not.toHaveBeenCalled();
  });
});

describe('renderMarkdown on planner text', () => {
  const parsed = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
  };
  const linkOf = (html: string) => parsed(html).querySelector('a');

  it('lets no quote in a link carry an attribute out of its href', () => {
    const html = parsed(renderMarkdown('[docs](https://x.test/" style="position:fixed;inset:0" data-x=")'));

    expect(html.querySelector('[style]')).toBeNull();
    expect(html.querySelector('[data-x]')).toBeNull();
  });

  it('links only web URLs; anything else stays text', () => {
    expect(linkOf(renderMarkdown('[run](javascript:alert(1))'))).toBeNull();
    expect(linkOf(renderMarkdown('[docs](https://example.com/a)'))?.getAttribute('href')).toBe('https://example.com/a');
  });
});
