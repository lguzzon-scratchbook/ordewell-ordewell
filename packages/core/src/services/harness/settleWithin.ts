/** What a wait that also ends with a process says about that ending. */
type ProcessEnding<R> =
  | { ended: Promise<unknown>; onEnded(): R }
  | { ended?: undefined; onEnded?: undefined };

export type SettleWithin<R> = { timeoutMs: number; onTimeout(): R } & ProcessEnding<R>;

/**
 * Wait for `promise`, the deadline, or the process ending, whichever is first.
 * Timing out and the process ending are different answers — a caller that
 * would retry after one gives up after the other — so each has its own
 * outcome, and either may throw to fail the wait instead.
 *
 * The first to settle wins and the others are inert: a late exit never runs
 * `onEnded`, and the timer never outlives the wait. A promise ready before
 * the call beats an exit that is also already seen.
 */
export function settleWithin<T, R = T>(promise: Promise<T>, wait: SettleWithin<R>): Promise<T | R> {
  return new Promise<T | R>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => T | R) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { resolve(outcome()); } catch (err) { reject(err); }
    };
    const timer = setTimeout(() => settle(wait.onTimeout), wait.timeoutMs);
    timer.unref?.();
    promise.then((value) => settle(() => value), (err: unknown) => settle(() => { throw err; }));
    if (wait.ended) {
      const { onEnded } = wait;
      void wait.ended.then(() => settle(onEnded));
    }
  });
}
