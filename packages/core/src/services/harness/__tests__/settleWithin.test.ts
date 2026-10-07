import { describe, it, expect, afterEach, vi } from 'vitest';
import { settleWithin } from '../settleWithin';

const never = <T>() => new Promise<T>(() => {});

afterEach(() => { vi.useRealTimers(); });

describe('settleWithin', () => {
  it('answers with the promise and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn(() => 'timeout');
    const onEnded = vi.fn(() => 'ended');

    await expect(settleWithin(Promise.resolve('value'), { timeoutMs: 1000, ended: never(), onTimeout, onEnded })).resolves.toBe('value');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('answers with the timeout outcome when nothing settles in time', async () => {
    vi.useFakeTimers();
    const waited = settleWithin(never<string>(), { timeoutMs: 1000, ended: never(), onTimeout: () => 'timeout', onEnded: () => 'ended' });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(waited).resolves.toBe('timeout');
  });

  it('answers with the exit outcome, not the timeout one, when the process ends first', async () => {
    vi.useFakeTimers();
    let end: () => void = () => {};
    const ended = new Promise<void>((resolve) => { end = resolve; });
    const onTimeout = vi.fn(() => 'timeout');
    const waited = settleWithin(never<string>(), { timeoutMs: 1000, ended, onTimeout, onEnded: () => 'ended' });
    end();
    await expect(waited).resolves.toBe('ended');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('never runs the exit outcome for an exit that comes after the wait was settled', async () => {
    let end: () => void = () => {};
    const ended = new Promise<void>((resolve) => { end = resolve; });
    const onEnded = vi.fn(() => 'ended');
    await settleWithin(Promise.resolve('value'), { timeoutMs: 1000, ended, onTimeout: () => 'timeout', onEnded });
    end();
    await Promise.resolve();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('prefers a promise that is already settled over an exit that is also already seen', async () => {
    await expect(settleWithin(Promise.resolve('value'), { timeoutMs: 1000, ended: Promise.resolve(), onTimeout: () => 'timeout', onEnded: () => 'ended' }))
      .resolves.toBe('value');
  });

  it('fails the wait when an outcome throws, so a caller can turn a timeout or an exit into its own error', async () => {
    vi.useFakeTimers();
    const timedOut = settleWithin(never<void>(), { timeoutMs: 10, ended: never(), onTimeout: () => { throw new Error('too slow'); }, onEnded: () => undefined });
    const rejection = expect(timedOut).rejects.toThrow('too slow');
    await vi.advanceTimersByTimeAsync(10);
    await rejection;

    await expect(settleWithin(never<void>(), { timeoutMs: 1000, ended: Promise.resolve(), onTimeout: () => undefined, onEnded: () => { throw new Error('gone'); } }))
      .rejects.toThrow('gone');
  });

  it('passes a rejection of the promise through and clears its timer', async () => {
    vi.useFakeTimers();
    await expect(settleWithin(Promise.reject(new Error('refused')), { timeoutMs: 1000, onTimeout: () => 'timeout' })).rejects.toThrow('refused');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits on the deadline alone when no process is named', async () => {
    vi.useFakeTimers();
    const waited = settleWithin(never<string>(), { timeoutMs: 50, onTimeout: () => 'timeout' });
    await vi.advanceTimersByTimeAsync(50);
    await expect(waited).resolves.toBe('timeout');
  });
});
