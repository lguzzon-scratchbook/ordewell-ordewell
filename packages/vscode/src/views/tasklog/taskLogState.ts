import { approvalLabel } from '@ordewell/core/plan-utils';
import type { TaskLogStatus } from '../../shared/taskLogProtocol';

export type TaskLogStateKind = 'approval' | 'working' | 'waiting' | 'checkpoint' | 'done' | 'failed' | 'idle';

export interface TaskLogState {
  kind: TaskLogStateKind;
  label: string;
}

/**
 * What a task log's header says the task is doing (ADR-0018, V1): a runner
 * request waiting for an answer first — the turn is live but stopped on it
 * (A1) — then the live turn, then the saved reason it waits, then how it
 * settled.
 */
export function taskLogState(
  status: Pick<TaskLogStatus, 'working' | 'awaitingReason' | 'awaitingApproval' | 'planStatus' | 'lastTurnEnd'>,
): TaskLogState {
  const approvals = approvalLabel(status.awaitingApproval);
  if (approvals) return { kind: 'approval', label: approvals };
  if (status.working) return { kind: 'working', label: 'Working' };
  switch (status.awaitingReason) {
    case 'checkpoint': return { kind: 'checkpoint', label: 'Waiting at a checkpoint' };
    case 'input': return { kind: 'waiting', label: 'Waiting for your input' };
    case 'conflict': return { kind: 'waiting', label: 'Waiting on a merge conflict' };
  }
  if (status.planStatus === 'completed') return { kind: 'done', label: 'Done' };
  if (status.planStatus === 'failed') return { kind: 'failed', label: 'Failed' };
  if (status.lastTurnEnd === 'failed') return { kind: 'failed', label: 'Turn failed' };
  if (status.lastTurnEnd === 'interrupted') return { kind: 'idle', label: 'Interrupted' };
  return { kind: 'idle', label: 'Idle' };
}
