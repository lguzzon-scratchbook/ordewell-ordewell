import { describe, it, expect, vi } from 'vitest';
import { serializePlan, type LegacyPlanState } from '@ordewell/core';
import { handleSessionMessage, type PlanManagerDeps } from '../PlanManager';

function deps() {
  const chatProvider = { conversation: { receive: vi.fn() }, showPendingPlanEdits: vi.fn() };
  return { d: { chatProvider } as unknown as PlanManagerDeps, chatProvider };
}

function plan(queuedMessages: LegacyPlanState['queuedMessages']): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks: [], generatedAt: now, status: 'running', runners: ['claude-code'], lastUpdated: now, queuedMessages };
}

describe('pending plan edits routing', () => {
  it('empties the webview\'s pending edits once the Session has applied them', () => {
    const { d, chatProvider } = deps();

    handleSessionMessage({ type: 'plan_generated', plan: serializePlan(plan([])), goal: 'g', runners: ['claude-code'] }, d);

    expect(chatProvider.showPendingPlanEdits).toHaveBeenCalledWith([]);
  });

  it('keeps showing an edit queued after the one applied', () => {
    const { d, chatProvider } = deps();
    const later = { id: 'q-2', text: 'also add tests', timestamp: new Date().toISOString() };

    handleSessionMessage({ type: 'plan_generated', plan: serializePlan(plan([later])), goal: 'g', runners: ['claude-code'] }, d);

    expect(chatProvider.showPendingPlanEdits).toHaveBeenCalledWith([later]);
  });
});
