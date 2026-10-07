import { flag, hasFlag, positionals, readLastSession, resolveTaskId } from '../utils';
import { askYesNo, fail } from './shared';
import { ensureDaemon, resolvePort } from '../daemon';
import { ApiClient } from '../apiClient';
import { pastGateConfirmation, titledTaskRef, type SerializedPlan } from '@ordewell/core';

type Action = 'run' | 'force-start' | 'retry' | 'cancel';

const PAST_TENSE: Record<Action, string> = {
  run: 'Task started.',
  'force-start': 'Task force-started.',
  retry: 'Task retried.',
  cancel: 'Task cancelled.',
};

/**
 * Resolve `--session-id` (falling back to the last planned session) and turn a
 * task identifier into a real task ID. Shared by every task-scoped command.
 */
export async function withResolvedTask(
  subArgs: string[],
  usage: string,
  injectedApi: ApiClient | undefined,
  run: (api: ApiClient, sessionId: string, taskId: string, plan: SerializedPlan) => Promise<void>,
): Promise<void> {
  const workspace = flag(subArgs, '--workspace') || process.cwd();
  let sessionId = flag(subArgs, '--session-id');
  if (!sessionId) {
    const last = readLastSession(workspace);
    if (!last) {
      console.error(`No session specified. Use --session-id <id> or run \`ordewell plan\` in ${workspace} first.`);
      process.exit(1);
    }
    sessionId = last.sessionId;
  }

  const identifier = positionals(subArgs)[0];
  if (!identifier) {
    console.error(usage);
    process.exit(1);
  }

  const api = injectedApi || new ApiClient(await ensureDaemon(resolvePort(subArgs)));

  let plan;
  try {
    plan = (await api.getSession(sessionId, workspace)).plan;
  } catch (err) {
    console.error(`Failed to load session: ${(err as Error).message}`);
    process.exit(1);
  }

  const taskId = resolveTaskId(plan, identifier);
  if (!taskId) {
    console.error(`Task not found: "${identifier}"`);
    process.exit(1);
  }

  await run(api, sessionId, taskId, plan as SerializedPlan);
}

/** Starting a task outside the scheduler, which is what can pass a merge gate. */
const PASSES_GATE: ReadonlySet<Action> = new Set<Action>(['run', 'force-start']);

/**
 * A start that passes a merge gate (ADR-0020) asks first, naming the work the
 * task would act without; `--yes` is the scriptable way to have asked already.
 */
async function confirmPastGate(subArgs: string[], api: ApiClient, sessionId: string, taskId: string, confirm: (question: string) => Promise<boolean>): Promise<void> {
  if (hasFlag(subArgs, '--yes')) return;
  // A daemon that cannot say (an older one, or a session it does not hold) is
  // left to answer the start itself.
  const unmerged = await api.getMergeGate(sessionId, taskId).catch(() => []);
  if (unmerged.length === 0) return;
  const question = `${pastGateConfirmation(unmerged.map((d) => titledTaskRef(d)))} Start it anyway?`;
  if (!(await confirm(question))) fail('Not started — nothing was changed. Pass --yes to start it without a prompt.');
}

function makeHandler(action: Action, command: string = action) {
  const yes = PASSES_GATE.has(action) ? ' [--yes]' : '';
  return async function handle(subArgs: string[], injectedApi?: ApiClient, confirm: (question: string) => Promise<boolean> = askYesNo): Promise<void> {
    await withResolvedTask(
      subArgs,
      `Usage: ordewell ${command} <task-id-or-order> [--session-id <id>] [--workspace /path]${yes}`,
      injectedApi,
      async (api, sessionId, taskId) => {
        if (PASSES_GATE.has(action)) await confirmPastGate(subArgs, api, sessionId, taskId, confirm);
        try {
          await api.taskControl(sessionId, taskId, action);
          console.log(PAST_TENSE[action]);
        } catch (err) {
          console.error(`Failed to ${action} task: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );
  };
}

/**
 * Continue a finished structured task in its saved runner session, with the
 * rest of the line as its next turn (ADR-0018, K1). The daemon starts the new
 * attempt; its progress is followed like any run (`ordewell status`).
 */
export async function handleContinue(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const usage = 'Usage: ordewell continue <task-id-or-order> <message> [--session-id <id>] [--workspace /path]';
  const message = positionals(subArgs).slice(1).join(' ').trim();
  if (!message) {
    console.error(usage);
    process.exit(1);
  }
  await withResolvedTask(subArgs, usage, injectedApi, async (api, sessionId, taskId) => {
    try {
      await api.continueTask(sessionId, taskId, message);
      console.log('Task continued.');
    } catch (err) {
      console.error(`Failed to continue task: ${(err as Error).message}`);
      process.exit(1);
    }
  });
}

/**
 * Answer the checkpoint a task waits at. Approving carries no note — what the
 * runner is told is just "continue" — so one given is refused rather than
 * dropped; a rejection's reason is the rest of the line.
 */
export async function handleCheckpoint(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const usage = 'Usage: ordewell checkpoint <task-id-or-order> approve|reject [reason] [--session-id <id>] [--workspace /path]';
  const [, answer, ...words] = positionals(subArgs);
  const reason = words.join(' ').trim();
  if (answer !== 'approve' && answer !== 'reject') {
    console.error(usage);
    process.exit(1);
  }
  if (answer === 'approve' && reason) {
    console.error(`Approving takes no note — reject with a reason to tell the task something.\n${usage}`);
    process.exit(1);
  }
  await withResolvedTask(subArgs, usage, injectedApi, async (api, sessionId, taskId) => {
    try {
      if (answer === 'approve') await api.approveTaskCheckpoint(sessionId, taskId);
      else await api.rejectTaskCheckpoint(sessionId, taskId, reason || undefined);
      console.log(answer === 'approve' ? 'Checkpoint approved.' : 'Checkpoint rejected.');
    } catch (err) {
      console.error(`Failed to ${answer} checkpoint: ${(err as Error).message}`);
      process.exit(1);
    }
  });
}

export const handleRunTask = makeHandler('run', 'run-task');
export const handleForceStart = makeHandler('force-start');
export const handleRetry = makeHandler('retry');
export const handleCancel = makeHandler('cancel');
