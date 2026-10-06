import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import type { DisplayBlock } from '@ordewell/core';
import { replayTaskLog } from '@ordewell/core/plan-utils';
import TaskLogApp from '../TaskLogApp';
import type { HostToTaskLog, TaskLogStatus } from '../../../shared/taskLogProtocol';

const api = (globalThis as unknown as { __vscodeApi: { postMessage: ReturnType<typeof vi.fn> } }).__vscodeApi;

function send(msg: HostToTaskLog): void {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: msg })); });
}

function status(overrides: Partial<TaskLogStatus> = {}): TaskLogStatus {
  return {
    taskId: 't1', order: 2, title: 'Parse JSON', runner: 'claude-code',
    planStatus: 'in_progress', awaitingApproval: 0, working: false, queued: [], attempts: [1], attempt: 1, continuable: false,
    ...overrides,
  };
}

const message = (id: string, text: string): DisplayBlock => ({ type: 'message', id, role: 'agent', text, streaming: false });

function init(overrides: Partial<TaskLogStatus> = {}, blocks: DisplayBlock[] = [message('b1', 'hello from the agent')]): void {
  send({ type: 'init', status: status(overrides), blocks });
}

describe('the task log tab (ADR-0018, V1)', () => {
  beforeEach(() => {
    cleanup();
    api.postMessage.mockClear();
  });

  it('asks the host for the log when it mounts', () => {
    render(<TaskLogApp />);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('draws the saved blocks through the chat components', () => {
    render(<TaskLogApp />);
    init();

    expect(screen.getByText('Task 2 · Parse JSON')).toBeTruthy();
    expect(screen.getByText('hello from the agent')).toBeTruthy();
  });

  it('applies a live patch to the blocks it was sent', () => {
    render(<TaskLogApp />);
    init({}, [message('b1', 'first')]);
    send({ type: 'patch', order: ['b1', 'b2'], changed: [message('b2', 'second')] });

    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
  });

  it('shows the live state and sends a message on Send', () => {
    render(<TaskLogApp />);
    init({ working: true, awaitingReason: 'input' });
    expect(screen.getByText('Working')).toBeTruthy();

    const input = screen.getByPlaceholderText(/Message the task/);
    act(() => { fireEvent.change(input, { target: { value: 'use Postgres' } }); });
    act(() => { fireEvent.click(screen.getByLabelText('Send')); });

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'use Postgres' });
  });

  it('shows an undelivered message from the task log with an empty queue', () => {
    render(<TaskLogApp />);
    const view = replayTaskLog([
      { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
      { type: 'message_undelivered', messageId: 'm1', text: 'use Postgres' },
    ]);
    init({ queued: [...view.queued] }, [...view.blocks]);
    expect(screen.getByText('use Postgres · not delivered')).toBeTruthy();
    expect(screen.queryByTitle('Remove this message')).toBeNull();
  });

  it('lists queued messages and takes one back', () => {
    render(<TaskLogApp />);
    init({ queued: [{ id: 'q1', text: 'then add tests' }] });

    expect(screen.getByText('then add tests')).toBeTruthy();
    act(() => { fireEvent.click(screen.getByTitle('Remove this message')); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'removeQueuedTaskMessage', id: 'q1' });
  });

  it('is one button: disabled when idle and empty, Stop while a turn is live and empty, Send once typed', () => {
    render(<TaskLogApp />);
    init({ working: false });
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true);

    send({ type: 'status', status: status({ working: true }) });
    act(() => { fireEvent.click(screen.getByLabelText('Interrupt')); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'interruptTask' });

    act(() => { fireEvent.change(screen.getByPlaceholderText(/Message the task/), { target: { value: 'wait, use Postgres' } }); });
    expect(screen.queryByLabelText('Interrupt')).toBeNull();
    act(() => { fireEvent.click(screen.getByLabelText('Send')); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'wait, use Postgres' });
  });

  it('sends on Enter and keeps Shift+Enter for a new line', () => {
    render(<TaskLogApp />);
    init({ working: true });
    const input = screen.getByPlaceholderText(/Message the task/);
    act(() => { fireEvent.change(input, { target: { value: 'hello' } }); });

    act(() => { fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }); });
    expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'hello' });

    act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'hello' });
  });

  describe('Esc Esc to interrupt', () => {
    const esc = (input: HTMLElement): void => { act(() => { fireEvent.keyDown(input, { key: 'Escape' }); }); };

    it('arms on the first Esc with a hint and interrupts on the second', () => {
      render(<TaskLogApp />);
      init({ working: true });
      const input = screen.getByPlaceholderText(/Message the task/);

      esc(input);
      expect(screen.getByText('Press Esc again to stop')).toBeTruthy();
      expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'interruptTask' });

      esc(input);
      expect(screen.queryByText('Press Esc again to stop')).toBeNull();
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'interruptTask' });
    });

    it('lets the arm lapse after a pause', () => {
      vi.useFakeTimers();
      try {
        render(<TaskLogApp />);
        init({ working: true });
        esc(screen.getByPlaceholderText(/Message the task/));
        act(() => { vi.advanceTimersByTime(2_100); });
        expect(screen.queryByText('Press Esc again to stop')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does nothing when no turn is live', () => {
      render(<TaskLogApp />);
      init({ working: false });
      const input = screen.getByPlaceholderText(/Message the task/);
      esc(input);
      esc(input);
      expect(screen.queryByText('Press Esc again to stop')).toBeNull();
      expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'interruptTask' });
    });
  });

  it('follows a live patch into view', () => {
    const { container } = render(<TaskLogApp />);
    init({ working: true }, [message('b1', 'first')]);
    const body = container.querySelector('.task-log-body') as HTMLElement;
    let top = 0;
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });

    send({ type: 'patch', order: ['b1', 'b2'], changed: [message('b2', 'second')] });
    expect(top).toBe(600);
  });

  it('switches to an earlier attempt', () => {
    render(<TaskLogApp />);
    init({ attempts: [1, 2], attempt: 2 });

    act(() => { fireEvent.change(screen.getByLabelText('Attempt'), { target: { value: '1' } }); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'selectAttempt', attempt: 1 });
  });

  it('shows a control refusal the host reported', () => {
    render(<TaskLogApp />);
    init();
    send({ type: 'showError', error: 'Task is not running.' });

    expect(screen.getByText('Task is not running.')).toBeTruthy();
  });

  it('turns the message box into Continue for a finished task that can be continued (ADR-0018, K1)', () => {
    render(<TaskLogApp />);
    init({ planStatus: 'completed', continuable: true });

    const input = screen.getByPlaceholderText(/Continue the task/);
    act(() => { fireEvent.change(input, { target: { value: 'also handle arrays' } }); });
    act(() => { fireEvent.click(screen.getByLabelText('Continue')); });

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'continueTask', text: 'also handle arrays' });
    expect(screen.queryByLabelText('Send')).toBeNull();
  });

  describe('a runner\'s tool request (ADR-0018, A1)', () => {
    const request = (overrides: Partial<Extract<DisplayBlock, { type: 'approval' }>> = {}): DisplayBlock => ({
      type: 'approval', id: 'b2', approvalId: 'ap-1', kind: 'runner_tool', subject: 'Bash(npm test)', scope: 'Bash', status: 'pending', allowForTask: true,
      ...overrides,
    });

    it('offers Allow, Allow for this task and Deny, each sent with its whole decision', () => {
      render(<TaskLogApp />);
      init({ working: true, awaitingApproval: 1 }, [request()]);
      expect(screen.getByText('Waiting for approval', { selector: '.task-log-state' })).toBeTruthy();

      fireEvent.click(screen.getByText('Allow'));
      fireEvent.click(screen.getByText('Allow for this task'));
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'allow' } });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'allowForTask' } });
    });

    it('denies with the note typed on the card', () => {
      render(<TaskLogApp />);
      init({}, [request()]);
      fireEvent.change(screen.getByPlaceholderText(/Note to the agent/), { target: { value: '  write it under notes/ ' } });
      fireEvent.click(screen.getByText('Deny'));
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'deny', note: 'write it under notes/' } });
    });

    it('leaves out Allow for this task when the runner offered no grant', () => {
      render(<TaskLogApp />);
      init({}, [request({ allowForTask: false })]);
      expect(screen.queryByText('Allow for this task')).toBeNull();
      expect(screen.getByText('Allow')).toBeTruthy();
    });

    it('settles into how it was answered, with no buttons left', () => {
      render(<TaskLogApp />);
      init({}, [
        request({ status: 'granted', decidedBy: 'asked', forTask: true }),
        request({ id: 'b3', approvalId: 'ap-2', status: 'denied', decidedBy: 'asked', note: 'use notes/' }),
        request({ id: 'b4', approvalId: 'ap-3', status: 'withdrawn' }),
      ]);
      expect(screen.getByText('Approved for this task')).toBeTruthy();
      expect(screen.getByText('Note to the agent: use notes/')).toBeTruthy();
      expect(screen.getByText('Withdrawn')).toBeTruthy();
      expect(screen.queryByText('Allow')).toBeNull();
    });
  });
});

describe('a message the runner reads mid-turn (ADR-0023)', () => {
  beforeEach(() => {
    cleanup();
    api.postMessage.mockClear();
  });

  const before = [
    { type: 'turn_start', message: 'Do the task' },
    { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"sleep 20"}' },
    { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
    { type: 'message_queued', messageId: 'm2', text: 'then add tests' },
    { type: 'message_handed_over', messageId: 'm1' },
  ] as const;

  it('marks a message the runner already has, with no way to take it back', () => {
    render(<TaskLogApp />);
    const view = replayTaskLog([...before]);
    init({ working: true, queued: [...view.queued] }, [...view.blocks]);

    expect(screen.getByText('handed over')).toBeTruthy();
    const removes = screen.getAllByTitle('Remove this message');
    expect(removes).toHaveLength(1);
    act(() => { fireEvent.click(removes[0]); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'removeQueuedTaskMessage', id: 'm2' });
  });

  it('draws the message in the log where the runner read it, and takes it off the queue', () => {
    render(<TaskLogApp />);
    const view = replayTaskLog([
      ...before,
      { type: 'tool_result', id: 'c1', output: '', success: true },
      { type: 'message_delivered', messageId: 'm1', text: 'use Postgres' },
      { type: 'text', text: 'Switching to Postgres.' },
    ]);
    init({ working: true, queued: [...view.queued] }, [...view.blocks]);

    expect(screen.queryByText('handed over')).toBeNull();
    const prompt = screen.getByText('Do the task');
    const read = screen.getByText('use Postgres');
    const reply = screen.getByText('Switching to Postgres.');
    expect(prompt.compareDocumentPosition(read) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(read.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('then add tests')).toBeTruthy();
  });
});
