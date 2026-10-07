import { describe, it, expect, vi } from 'vitest';
import { reportPlannerError, type PlanManagerDeps } from '../PlanManager';

function harness() {
  const showError = vi.fn();
  const deps = { chatProvider: { showError } } as unknown as PlanManagerDeps;
  return { deps, showError };
}

describe('reportPlannerError', () => {
  it('reports a real failure whose message happens to mention "aborted"', () => {
    const { deps, showError } = harness();
    reportPlannerError(new Error('runner exited: transaction aborted'), deps);
    expect(showError).toHaveBeenCalledWith('Planner failed: runner exited: transaction aborted');
  });

  it('stays quiet for an AbortError', () => {
    const { deps, showError } = harness();
    reportPlannerError(new DOMException('Aborted', 'AbortError'), deps);
    expect(showError).not.toHaveBeenCalled();
  });

  it('stays quiet for any error once the turn\'s own signal was aborted', () => {
    const { deps, showError } = harness();
    const controller = new AbortController();
    controller.abort();
    reportPlannerError(new Error('spawn failed'), deps, controller.signal);
    expect(showError).not.toHaveBeenCalled();
  });
});
