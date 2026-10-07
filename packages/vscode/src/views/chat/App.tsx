import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import EmptyState from './components/EmptyState';
import GetStarted from './components/GetStarted';
import ChatInput from './components/ChatInput';
import DockResizeHandle from './components/DockResizeHandle';
import { ConversationBlocks } from './components/ChatMessage';
import { appendTaskOutput, type TaskOutputMap } from './taskOutput';
import ModelSelector, { API_PROVIDER_LABELS } from './components/ModelSelector';
import PlanCardGroup from './components/PlanCardGroup';
import UsageLine from './components/UsageLine';
import QueuedPrompts from './components/QueuedPrompts';
import HandoffCard from './components/HandoffCard';
import CheckpointPanel from './components/CheckpointPanel';
import type { RunnerMode } from './components/TaskCard';
import type { TaskDraft } from './components/NewTaskCard';
import type { LegacyPlanState, DiscoveredModel, Task, TaskModelAssignment, RunnerId, RunnerTransport, IsolationHandoff, IsolationMergeResult, MergeGateView, TaskIsolation } from '@ordewell/core';
import type { AiProvider } from '@ordewell/core';
import { isPlanRevision, planSummaryLabel, nextDock } from './planDock';
import { DetailContext } from './detail';
import { useFollowOutput } from './followOutput';
import { slashHelp } from '../../commands/slashCommands';
import type { HostToWebview, PendingPlanEdit, PlannerBackend, RunnerMeta, WebviewToHost } from '../../shared/protocol';
import { EMPTY_HOLD, hasHiddenDetail, type PromptHold } from '@ordewell/core/plan-utils';
import { applyConversationPatch, EMPTY_PATCHED_VIEW, patchedBlocks, type PatchedView } from '../../shared/conversationPatch';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

const STOP_ARM_MS = 2_000;

interface RunnerInfo {
  id: string;
  displayName: string;
}

export default function App() {
  /** The planner conversation, held by the host and patched in here (#53). */
  const [conversation, setConversation] = useState<PatchedView>(EMPTY_PATCHED_VIEW);
  const blocks = useMemo(() => patchedBlocks(conversation), [conversation]);
  const [detailAll, setDetailAll] = useState(false);
  const detail = useMemo(() => ({ detailAll, setDetailAll }), [detailAll]);
  const [plan, setPlan] = useState<LegacyPlanState | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isResearchActive, setIsResearchActive] = useState(false);
  const [conversationBusy, setConversationBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [modelsByRunner, setModelsByRunner] = useState<Partial<Record<string, DiscoveredModel[]>>>({});
  const [runnerList, setRunnerList] = useState<RunnerInfo[]>([]);
  const [enabledRunnerIds, setEnabledRunnerIds] = useState<string[]>(['claude-code']);
  const [runners, setRunners] = useState<RunnerId[]>(['claude-code']);
  const [pendingEdits, setPendingEdits] = useState<PendingPlanEdit[]>([]);
  /** Queued prompts: what the host is holding for the next planner turn. */
  const [held, setHeld] = useState<PromptHold>(EMPTY_HOLD);
  /** The last queued text the host gave back, for the input to take in. `seq` makes a repeat of the same words land again. */
  /** A first Esc during a planner turn: one more within `STOP_ARM_MS` stops it. */
  const [stopArmed, setStopArmed] = useState(false);
  const [unsent, setUnsent] = useState<{ text: string; seq: number } | null>(null);
  const [, setCurrentGoal] = useState<string>('');
  const [showModelInfo, setShowModelInfo] = useState(false);
  const [slashOutput, setSlashOutput] = useState('');
  const [modesByRunner, setModesByRunner] = useState<Record<string, RunnerMode[]>>({});
  const [modelConfig, setModelConfig] = useState<{ orchestrator: string; orchestratorProvider?: string } | null>(null);
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[]>([]);
  const [configuredProviders, setConfiguredProviders] = useState<AiProvider[]>([]);
  /** Who plans (ADR-0009): the backends offered, the one in use, and its runner + effort. */
  const [planner, setPlanner] = useState<{
    backends: PlannerBackend[];
    provider: string;
    runner?: string;
    effort?: string;
  }>({ backends: [], provider: '' });
  const [isReady, setIsReady] = useState(false);
  const [, setModelApiMapping] = useState<Record<string, AiProvider[]>>({});
  const [modelDiscoveryErrors, setModelDiscoveryErrors] = useState<Record<string, string>>({});
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  const [setupCollapsed, setSetupCollapsed] = useState(false);
  const [tddEnabled, setTddEnabled] = useState(true);
  const [verifyEnabled, setVerifyEnabled] = useState(false);
  const [runnerTransport, setRunnerTransport] = useState<RunnerTransport>('structured');
  /** Discovered skills (~/.ordewell/skills/ + .ordewell/skills/) for the /skill-name suggestion dropdown. */
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);
  const [checkpoint, setCheckpoint] = useState<{ taskId: string; taskTitle: string; summary: string; pausedAt: number } | null>(null);
  const [taskOutput, setTaskOutput] = useState<TaskOutputMap>({});
  /** Advisory silence timestamp per task id, keyed like taskOutput; null/absent means not stalled. */
  const [taskIdle, setTaskIdle] = useState<Record<string, string | null>>({});
  const [taskApprovals, setTaskApprovals] = useState<Record<string, number>>({});
  /** Per-task isolation state (ADR-0013); only tasks an isolated run has touched appear. */
  const [taskIsolation, setTaskIsolation] = useState<Record<string, TaskIsolation>>({});
  /** The end-of-run handoff card, present until the run is merged, discarded or restarted. */
  const [handoff, setHandoff] = useState<IsolationHandoff | null>(null);
  /** What the last Merge all did; a blocked or part-landed group stays visible until the run clears. */
  const [mergeResult, setMergeResult] = useState<IsolationMergeResult | null>(null);
  /** While tasks wait at a merge gate (ADR-0020): what Merge all would merge now. */
  const [mergeGate, setMergeGate] = useState<MergeGateView | null>(null);
  /** Per task id, the dependencies it waits on at its merge gate. */
  const [taskGates, setTaskGates] = useState<Record<string, string[]>>({});
  /** Is the plan dock open? See planDock.ts for when this flips. */
  const [dockExpanded, setDockExpanded] = useState(false);
  /** The dock's dragged cap in px, remembered by the host; undefined keeps the stylesheet's default. */
  const [dockHeight, setDockHeight] = useState<number | undefined>(undefined);

  const messageListRef = useRef<HTMLDivElement | null>(null);
  const dockBodyRef = useRef<HTMLDivElement>(null);
  const helpTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const processingRef = useRef(false);
  const stoppedRef = useRef(false);
  const sessionClearedRef = useRef(false);
  const lastActivityRef = useRef(Date.now());
  const planRef = useRef(plan);
  planRef.current = plan;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  const isGenerating = isResearchActive || isExecuting;

  useEffect(() => {
    processingRef.current = isResearchActive || isExecuting;
  }, [isResearchActive, isExecuting]);

  // Queued prompts and the working line are drawn below the conversation
  // blocks: each must be followed too, or it renders past the fold with
  // nothing to bring it into view.
  const followRef = useFollowOutput<HTMLDivElement>(blocks, held, isResearchActive);
  const messageListCallbackRef = useCallback((el: HTMLDivElement | null) => {
    messageListRef.current = el;
    followRef(el);
  }, [followRef]);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      lastActivityRef.current = Date.now();
      switch (msg.type) {
        case 'setState':
          // The conversation is not cleared here: the host owns it and resets
          // it itself when the session really is new.
          if (msg.state === 'empty') {
            setError('');
            setPlan(null);
            setCheckpoint(null);
            setTaskOutput({});
            setTaskIdle({});
            setTaskApprovals({});
            setTaskIsolation({});
            setHandoff(null);
            setMergeResult(null);
            setMergeGate(null);
            setTaskGates({});
            setPendingEdits([]);
            setDockExpanded((v) => nextDock(v, 'session-reset'));
          }
          setIsResearchActive(msg.state === 'researching');
          setIsExecuting(msg.state === 'approved');
          break;

        case 'planUpdated': {
          if (stoppedRef.current) break;
          const incoming: LegacyPlanState | null = msg.plan ?? null;
          setPlan(incoming);
          // Not a turn's end: a run's status tick arrives mid-turn too, and
          // the host's `plannerTurn` is what says a turn is over.
          if (incoming) {
            setIsExecuting(incoming.status === 'running');
          }
          if (incoming && incoming.tasks && incoming.tasks.length > 0) {
            // One `planUpdated` carries two different events. A revision opens
            // the dock; a status tick during execution must not, or a running
            // plan would fight a user who collapsed it. The conversation's plan
            // marker comes from the host with the view.
            const previous = planRef.current?.tasks ?? [];
            if (isPlanRevision(previous, incoming.tasks)) {
              setDockExpanded((v) => nextDock(v, 'plan-revised'));
            } else {
              setDockExpanded((v) => nextDock(v, 'plan-progressed'));
            }
          }
          break;
        }

        case 'restoreChat': {
          // A session was (re)loaded (session load, webview reload, window
          // restore); its conversation follows as a patch. Also clears stuck
          // state: a restore always leaves the chat usable. The plan is cleared
          // here so a session with no tasks does not keep the previously-loaded
          // session's plan cards — a follow-up planUpdated repopulates it when
          // the restored session has tasks.
          stoppedRef.current = false;
          sessionClearedRef.current = false;
          setIsResearchActive(false);
          setIsExecuting(false);
          setError('');
          setCheckpoint(null);
          setPlan(null);
          setTaskOutput({});
          setTaskIsolation({});
          setHandoff(null);
          setMergeResult(null);
          setMergeGate(null);
          setTaskGates({});
          // A restore is followed by the host's own pendingPlanEdits; clearing
          // here keeps a stale session's edits from flashing until they land.
          setPendingEdits([]);
          setHeld(EMPTY_HOLD);
          setDockExpanded((v) => nextDock(v, 'session-reset'));
          break;
        }

        case 'conversationPatch':
          setConversation((prev) => applyConversationPatch(prev, msg));
          break;

        // The stop gate lasts until the host has closed the stopped turn; a
        // new turn is never gated.
        case 'plannerTurn':
          stoppedRef.current = false;
          setIsResearchActive(msg.active);
          break;

        // Nothing to draw: arriving at all is what keeps the watchdog quiet.
        case 'plannerLiveness':
          break;

        case 'conversationBusy':
          setConversationBusy(!!msg.busy);
          break;

        case 'showError':
          if (sessionClearedRef.current) break;
          setError(msg.error);
          setIsResearchActive(false);
          break;

        case 'taskOutput':
          setTaskOutput((prev) => appendTaskOutput(prev, msg.taskId, msg.text ?? ''));
          break;

        case 'taskIdle':
          setTaskIdle((prev) => ({ ...prev, [msg.taskId]: msg.idleSince }));
          break;

        case 'taskApprovals':
          setTaskApprovals((prev) => ((prev[msg.taskId] ?? 0) === msg.count ? prev : { ...prev, [msg.taskId]: msg.count }));
          break;

        case 'taskIsolation':
          setTaskIsolation((prev) => ({ ...prev, [msg.taskId]: msg.isolation }));
          break;

        case 'isolationHandoff':
          setHandoff({
            repos: msg.repos ?? [],
            landed: msg.landed ?? [],
          });
          break;

        case 'isolationMergeResult':
          setMergeResult(msg.result ?? null);
          break;

        case 'isolationCleared':
          setTaskIsolation({});
          setHandoff(null);
          setMergeResult(null);
          setMergeGate(null);
          setTaskGates({});
          break;

        case 'mergeGate':
          setMergeGate(msg.gate ?? null);
          setTaskGates(msg.tasks ?? {});
          break;

        case 'setModels':
          setModels(msg.models ?? []);
          break;

        case 'setModelsByRunner':
          setModelsByRunner(msg.modelsByRunner ?? {});
          break;

        case 'setModesByRunner':
          setModesByRunner(msg.modesByRunner ?? {});
          break;

        case 'setModelConfig':
          setModelConfig(msg.modelConfig ?? null);
          break;

        case 'setModelOptions':
          setModelOptions(msg.modelOptions ?? []);
          break;

        case 'setConfiguredProviders':
          setConfiguredProviders(msg.providers ?? []);
          setIsReady(true);
          break;

        case 'setPlannerBackends':
          setPlanner({
            backends: msg.backends ?? [],
            provider: msg.provider ?? '',
            runner: msg.runner,
            effort: msg.effort || undefined,
          });
          break;

        case 'setModelDiscoveryErrors':
          setModelDiscoveryErrors(msg.errors ?? {});
          break;
        case 'setModelApiMapping':
          setModelApiMapping(msg.modelApiMapping ?? {});
          break;

        case 'setRunners': {
          const list = msg.runners ?? [];
          const ids = list.filter((r: RunnerMeta) => r.enabled).map((r: RunnerMeta) => r.id);
          setRunnerList(list.map((r: RunnerMeta) => ({ id: r.id, displayName: r.displayName })));
          setEnabledRunnerIds(ids);
          setRunners((prev) => {
            if (ids.length === 1) return ids;
            if (ids.length === 0) return ['claude-code'];
            const valid = prev.filter((r) => ids.includes(r));
            return valid.length > 0 ? valid : ids;
          });
          break;
        }

        case 'pendingPlanEdits':
          setPendingEdits(msg.edits ?? []);
          break;

        case 'heldPrompts':
          setHeld(msg.prompts);
          break;

        case 'promptUnsent':
          setUnsent((prev) => ({ text: msg.text, seq: (prev?.seq ?? 0) + 1 }));
          break;

        case 'setGoal':
          setCurrentGoal(msg.goal ?? '');
          break;

        case 'setSkillToggles':
          if (msg.toggles) {
            setTddEnabled(msg.toggles.tdd ?? true);
            setVerifyEnabled(msg.toggles.verify ?? false);
          }
          break;

        case 'setSkills':
          setSkills(msg.skills ?? []);
          break;

        case 'runnerTransport':
          setRunnerTransport(msg.transport);
          break;

        case 'planDockHeight':
          setDockHeight(msg.height);
          break;

        case 'checkpoint':
          setCheckpoint({
            taskId: msg.taskId ?? '',
            taskTitle: msg.taskTitle ?? '',
            summary: msg.summary ?? '',
            pausedAt: Date.now(),
          });
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    vscode.postMessage({ type: 'ready' });
    const fallback = setTimeout(() => setIsReady(true), 4000);
    return () => clearTimeout(fallback);
  }, []);

  const pushSystem = useCallback((text: string) => {
    vscode.postMessage({ type: 'addNote', text });
  }, []);

  // Watchdog: if the planner is "working" but nothing has arrived from the
  // host for a long stretch (a turn's end was lost, the turn died silently),
  // unlock the input instead of leaving the chat bricked. A harness planner
  // quiet on screen still sends liveness, so only real silence trips it; the
  // window is generous — non-streaming providers can legitimately stay quiet
  // for a minute while a model thinks.
  const WATCHDOG_MS = 120_000;
  useEffect(() => {
    if (!isResearchActive) return;
    lastActivityRef.current = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - lastActivityRef.current < WATCHDOG_MS) return;
      setIsResearchActive(false);
      pushSystem('The planner stopped responding, so the input was re-enabled. Your last message may not have been processed — try sending it again.');
    }, 5_000);
    return () => clearInterval(timer);
  }, [isResearchActive, pushSystem]);

  const handleNewSession = useCallback(() => {
    stoppedRef.current = true;
    sessionClearedRef.current = true;
    setPlan(null);
    setIsResearchActive(false);
    setIsExecuting(false);
    setError('');
    setCheckpoint(null);
    setTaskOutput({});
    setTaskIsolation({});
    setHandoff(null);
    setMergeResult(null);
    setMergeGate(null);
    setTaskGates({});
    setPendingEdits([]);
    setHeld(EMPTY_HOLD);
    setDockExpanded((v) => nextDock(v, 'session-reset'));
    // A distinct message from stopResearch: /new resets the whole session,
    // while Stop only aborts the current planner turn.
    vscode.postMessage({ type: 'newSession' });
  }, []);

  const handleSend = useCallback((text: string) => {
    if (text.trim() === '/model') {
      setShowModelInfo((prev) => !prev);
      return;
    }
    if (text === '/new') {
      const hasContent = blocksRef.current.length > 0 || planRef.current !== null;
      if ((hasContent || processingRef.current) && !showNewSessionConfirm) {
        setShowNewSessionConfirm(true);
        return;
      }
      setShowNewSessionConfirm(false);
      handleNewSession();
      return;
    }
    if (text === '/help') {
      setSlashOutput(slashHelp());
      clearTimeout(helpTimerRef.current);
      helpTimerRef.current = setTimeout(() => setSlashOutput(''), 6000);
      return;
    }

    if (text.startsWith('/')) {
      vscode.postMessage({ type: 'sendMessage', text, runners, typed: true });
      return;
    }

    if (isResearchActive) {
      vscode.postMessage({ type: 'holdPrompt', text });
      return;
    }

    setShowModelInfo(false);
    setSlashOutput('');
    clearTimeout(helpTimerRef.current);
    setShowNewSessionConfirm(false);
    stoppedRef.current = false;
    sessionClearedRef.current = false;
    setError('');
    // Locked at once rather than when the turn opens: the host may take a
    // moment to start it, and a second send in between would race the first.
    setIsResearchActive(true);
    vscode.postMessage({ type: 'sendMessage', text, runners, typed: true });
  }, [runners, handleNewSession, showNewSessionConfirm, isResearchActive]);

  const handleToggleRunner = useCallback((runnerId: RunnerId) => {
    setRunners((prev) => {
      if (prev.includes(runnerId)) {
        const next = prev.filter((r) => r !== runnerId);
        return next.length > 0 ? next : prev;
      }
      return [...prev, runnerId];
    });
  }, []);

  const handleConfigureApiKey = useCallback((provider: 'openrouter' | 'google' | 'openai_compatible') => {
    vscode.postMessage({ type: 'sendMessage', text: `/key ${provider}`, runners });
  }, [runners]);

  const handleLoadSession = useCallback(() => {
    vscode.postMessage({ type: 'sendMessage', text: '/sessions', runners });
  }, [runners]);

  // A task card's own edit shows at once; the host's next plan settles it.
  const echoTask = useCallback((taskId: string, patch: Partial<Task>) => {
    const patchIn = (tasks: Task[]): Task[] => tasks.map((t) => {
      if (t.id === taskId) return { ...t, ...patch };
      return t.subtasks.length > 0 ? { ...t, subtasks: patchIn(t.subtasks) } : t;
    });
    setPlan((current) => (current ? { ...current, tasks: patchIn(current.tasks) } : current));
  }, []);

  const handlePromptChange = useCallback((taskId: string, prompt: string) => {
    vscode.postMessage({ type: 'editTask', taskId, edit: { kind: 'prompt', prompt } });
    echoTask(taskId, { prompt, description: prompt });
  }, [echoTask]);

  // No optimistic removal: the host asks for confirmation, so the card must
  // survive a "Cancel" and only disappear when the host echoes the new plan.
  const handleRemoveTask = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'removeTask', taskId });
  }, []);

  // Not echoed either: the host validates the edit against the whole graph and
  // refuses some lists, so the checkboxes must show what was accepted.
  const handleDependenciesChange = useCallback((taskId: string, dependencies: string[]) => {
    vscode.postMessage({ type: 'editTask', taskId, edit: { kind: 'dependencies', dependencies } });
  }, []);

  const handleAddTask = useCallback((draft: TaskDraft) => {
    vscode.postMessage({ type: 'addTask', draft });
  }, []);

  // Activation-time discovery can cache a degraded (empty) catalog for a runner
  // that was cold or unconfigured at that moment (see ModelDiscovery's
  // warnDegradedDiscovery). Unlike the TUI's task-model picker, which
  // re-fetches on every open, this webview only refreshes on activation, a
  // config change, or reconnect — so a stale empty list for an already-
  // assigned task's runner never self-heals on its own. Re-discover whenever a
  // task's model dropdown opens, same as the TUI does.
  const handleModelsRefreshNeeded = useCallback(() => {
    vscode.postMessage({ type: 'refreshModels' });
  }, []);

  const handleModelChange = useCallback((taskId: string, assignment: TaskModelAssignment) => {
    vscode.postMessage({ type: 'editTask', taskId, edit: { kind: 'model', assignment } });
    echoTask(taskId, { assignedModel: assignment });
  }, [echoTask]);

  // Only the runner is echoed optimistically. The model, effort and mode that
  // follow from it come from the new runner's catalog, which only the host can
  // read — guessing them here would display an unspawnable assignment until the
  // retargeted plan arrives.
  const handleRunnerChange = useCallback((taskId: string, runner: string) => {
    vscode.postMessage({ type: 'editTask', taskId, edit: { kind: 'runner', runner } });
    echoTask(taskId, { assignedRunner: runner });
  }, [echoTask]);

  const handleModeChange = useCallback((taskId: string, mode: string) => {
    vscode.postMessage({ type: 'editTask', taskId, edit: { kind: 'mode', mode } });
    echoTask(taskId, { taskMode: mode });
  }, [echoTask]);

  const handleOpsChange = useCallback((taskId: string, ops: boolean) => {
    vscode.postMessage({ type: 'editTask', taskId, edit: { kind: 'ops', ops } });
    echoTask(taskId, { ops });
  }, [echoTask]);

  const handleRetry = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'retry', taskId });
  }, []);

  const handleSkip = useCallback((taskId: string) => {
    const taskTitle = planRef.current?.tasks.find((t) => t.id === taskId)?.title ?? taskId;
    vscode.postMessage({ type: 'sendSystemCommand', command: 'skip', taskId });
    pushSystem(`Task "${taskTitle}" skipped.`);
  }, [pushSystem]);

  const handleCancel = useCallback((taskId: string) => {
    const taskTitle = planRef.current?.tasks.find((t) => t.id === taskId)?.title ?? taskId;
    vscode.postMessage({ type: 'sendSystemCommand', command: 'cancel', taskId });
    pushSystem(`Task "${taskTitle}" cancelled.`);
  }, [pushSystem]);

  // No notice of its own: the task's start comes back from the session and
  // is announced by the host, as every start is.
  const handleForceStart = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'forceStart', taskId });
  }, []);

  const handleExecutePlan = useCallback(() => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'executePlan' });
    pushSystem('Plan execution started.');
  }, [pushSystem]);

  const handleStopExecution = useCallback(() => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'stopExecution' });
    pushSystem('Execution stopped.');
  }, [pushSystem]);

  const handleRunTask = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'sendSystemCommand', command: 'runTask', taskId });
  }, []);

  // The log tab is the host's webview panel (ADR-0018, V1); the chat only asks
  // for it. Opening is idempotent host-side — an open tab is focused.
  const handleOpenTaskLog = useCallback((taskId: string) => {
    vscode.postMessage({ type: 'openTaskLog', taskId });
  }, []);

  const handleMarkComplete = useCallback((taskId: string) => {
    const taskTitle = planRef.current?.tasks.find((t) => t.id === taskId)?.title ?? taskId;
    vscode.postMessage({ type: 'sendSystemCommand', command: 'markComplete', taskId });
    pushSystem(`Task "${taskTitle}" marked complete.`);
  }, [pushSystem]);

  const handleMarkIncomplete = useCallback((taskId: string) => {
    const taskTitle = planRef.current?.tasks.find((t) => t.id === taskId)?.title ?? taskId;
    vscode.postMessage({ type: 'sendSystemCommand', command: 'markIncomplete', taskId });
    pushSystem(`Task "${taskTitle}" marked not done.`);
  }, [pushSystem]);

  // The card answers into the same resolution every surface uses; the outcome
  // comes back as `approval_settled` and redraws the card.
  const handleResolveApproval = useCallback((id: string, granted: boolean) => {
    vscode.postMessage({ type: 'resolveApproval', id, granted });
  }, []);

  // The host owns the edits; withdrawing removes one here at once so the click
  // feels immediate, and the host's own pendingPlanEdits settles the list.
  const handleRemovePendingEdit = useCallback((id: string) => {
    setPendingEdits((prev) => prev.filter((m) => m.id !== id));
    vscode.postMessage({ type: 'removePendingPlanEdit', id });
  }, []);

  const handleUnsend = useCallback(() => {
    vscode.postMessage({ type: 'unsendPrompt' });
  }, []);

  const stopTurn = useCallback(() => {
    stoppedRef.current = true;
    setIsResearchActive(false);
    vscode.postMessage({ type: 'stopResearch' });
  }, []);

  // Stopping a run is not stopping a turn: the stale-plan gate is the turn's,
  // and armed here it dropped every plan update after the run's stop.
  const handleStop = useCallback(() => {
    if (!isExecuting) {
      stopTurn();
      return;
    }
    setIsExecuting(false);
    vscode.postMessage({ type: 'sendSystemCommand', command: 'stopExecution' });
    pushSystem('Execution stopped.');
  }, [isExecuting, pushSystem, stopTurn]);

  // Esc during a planner turn, in order of intent: take back the newest queued
  // prompt, else arm a stop, else commit it. Outside a turn it is the input's.
  // The stop is the turn's even mid-run: Esc Esc never halts the tasks.
  const handleEscape = useCallback((): boolean => {
    if (!isResearchActive) return false;
    if (held.length > 0) {
      setStopArmed(false);
      handleUnsend();
    } else if (stopArmed) {
      setStopArmed(false);
      stopTurn();
    } else {
      setStopArmed(true);
    }
    return true;
  }, [isResearchActive, held, stopArmed, handleUnsend, stopTurn]);

  // The pairing is what keeps a stray tap from cancelling a turn, so an arm
  // lapses on its own, and never outlives the turn it was aimed at.
  useEffect(() => {
    if (!stopArmed) return;
    if (!isResearchActive) {
      setStopArmed(false);
      return;
    }
    const timer = setTimeout(() => setStopArmed(false), STOP_ARM_MS);
    return () => clearTimeout(timer);
  }, [stopArmed, isResearchActive]);

  const handleToggleSkill = useCallback((skillId: string) => {
    if (skillId === 'tdd') {
      const next = !tddEnabled;
      setTddEnabled(next);
      vscode.postMessage({ type: 'toggleSkill', skillId, enabled: next });
    } else if (skillId === 'verify') {
      const next = !verifyEnabled;
      setVerifyEnabled(next);
      vscode.postMessage({ type: 'toggleSkill', skillId, enabled: next });
    }
  }, [tddEnabled, verifyEnabled]);

  const handleToggleTransport = useCallback(() => {
    const next: RunnerTransport = runnerTransport === 'structured' ? 'terminal' : 'structured';
    setRunnerTransport(next);
    vscode.postMessage({ type: 'setRunnerTransport', transport: next });
  }, [runnerTransport]);

  const handleApproveCheckpoint = useCallback(() => {
    if (!checkpoint) return;
    vscode.postMessage({ type: 'answerCheckpoint', taskId: checkpoint.taskId, approved: true });
    setCheckpoint(null);
  }, [checkpoint]);

  const handleRejectCheckpoint = useCallback((reason: string) => {
    if (!checkpoint) return;
    // Reject resumes the paused agent with the reason (rather than cancelling
    // the task), and the panel is torn down immediately — leaving a decision
    // box on screen after the decision is made asks the user to answer twice.
    vscode.postMessage({ type: 'answerCheckpoint', taskId: checkpoint.taskId, approved: false, reason });
    setCheckpoint(null);
  }, [checkpoint]);

  const handleMergeTasks = useCallback((taskIds: string[]) => {
    const current = planRef.current;
    if (!current) return;
    const titles = taskIds.map((id) => current.tasks.find((t) => t.id === id)?.title ?? id);
    pushSystem(`Requesting merge of: ${titles.join(' + ')}.`);
    vscode.postMessage({ type: 'mergeTasks', taskIds });
  }, [pushSystem]);

  const handleSplitTask = useCallback((taskId: string) => {
    const current = planRef.current;
    if (!current) return;
    const task = current.tasks.find((t) => t.id === taskId);
    pushSystem(`Requesting split of: ${task?.title ?? taskId}.`);
    vscode.postMessage({ type: 'splitTask', taskId });
  }, [pushSystem]);

  // The host owns every isolation action: opening the diff, and the merge,
  // discard and cleanup that touch the user's real branches.
  const handleIsolationAction = useCallback((action: 'reviewDiff' | 'merge' | 'discard' | 'cleanup' | 'resolveConflict', taskId?: string) => {
    vscode.postMessage({ type: 'isolationAction', action, taskId });
  }, []);

  const handleDockResize = useCallback((height: number) => {
    setDockHeight(height);
    vscode.postMessage({ type: 'setPlanDockHeight', height });
  }, []);
  const handleShowPlan = useCallback(() => setDockExpanded((v) => nextDock(v, 'user-expanded')), []);

  const handleResolveConflict = useCallback((taskId: string) => {
    handleIsolationAction('resolveConflict', taskId);
  }, [handleIsolationAction]);

  const getPlaceholder = (): string => {
    if (isResearchActive) return 'Queue a message for when the planner is done...';
    if (isExecuting) return 'AI is working...';
    if (plan && plan.tasks.length > 0) return 'Modify the plan...';
    if (blocks.some((b) => b.type === 'message' && b.role === 'planner')) return 'Reply to the planner...';
    return 'Describe what you want to build...';
  };

  const vendorModels = useMemo<DiscoveredModel[]>(() =>
    // Carry the serving apiProvider through as runnerProvider (grouping key)
    // plus its display label, so the dropdown groups and labels each model by
    // its real provider (OpenAI, OpenRouter, Gemini, …) instead of guessing
    // from the id prefix.
    modelOptions.map((opt) => ({
      modelId: opt.id,
      modelLabel: opt.label,
      runnerProvider: opt.apiProvider,
      runnerProviderLabel: opt.apiProvider ? API_PROVIDER_LABELS[opt.apiProvider] : undefined,
      variants: [],
    })),
    [modelOptions],
  );

  /**
   * A harness planner runs a coding agent, so the only models it can serve are
   * that agent's own — and those carry the variants that make the effort
   * dropdown appear (ADR-0009). Offering it the vendor catalog would list
   * models it cannot run.
   */
  const orchestratorModels = useMemo<DiscoveredModel[]>(
    () => (planner.runner ? modelsByRunner[planner.runner as RunnerId] ?? [] : vendorModels),
    [planner.runner, modelsByRunner, vendorModels],
  );

  const harnessPlannerModels = useMemo(
    () => (planner.runner
      ? orchestratorModels.map((m) => ({ id: m.modelId, label: m.modelLabel, provider: planner.runner as string }))
      : undefined),
    [planner.runner, orchestratorModels],
  );

  const orchestratorModelApiMapping = useMemo<Record<string, AiProvider[]>>(() => {
    const mapping: Record<string, AiProvider[]> = {};
    for (const opt of modelOptions) {
      mapping[opt.id] = opt.apiProvider ? [opt.apiProvider] : [];
    }
    return mapping;
  }, [modelOptions]);

  const orchestratorCurrentModel = useMemo<TaskModelAssignment | undefined>(() => {
    if (!modelConfig?.orchestrator) return undefined;
    const discovered = orchestratorModels.find((m) => m.modelId === modelConfig.orchestrator);
    return {
      modelId: modelConfig.orchestrator,
      modelLabel: discovered?.modelLabel ?? modelConfig.orchestrator,
      thinkingEffort: planner.effort as TaskModelAssignment['thinkingEffort'],
    };
  }, [modelConfig, orchestratorModels, planner.effort]);

  const handleOrchestratorModelChange = useCallback((assignment: TaskModelAssignment) => {
    vscode.postMessage({ type: 'setPlannerModel', modelId: assignment.modelId, effort: assignment.thinkingEffort });
  }, []);

  const handlePlannerChange = useCallback((provider: string) => {
    if (provider === planner.provider) return;
    vscode.postMessage({ type: 'setPlanner', provider });
  }, [planner.provider]);

  const displayRunners = runnerList.length > 0
    ? runnerList
    : [
        { id: 'claude-code', displayName: 'Claude Code' },
        { id: 'codex', displayName: 'Codex' },
        { id: 'opencode', displayName: 'OpenCode' },
      ];

  const visibleRunners = displayRunners.filter((r) => enabledRunnerIds.includes(r.id));

  // An API key is one of two ways in (ADR-0009): an installed coding agent
  // plans on its own subscription, so key-less is a working setup, not a
  // first-run wall.
  const canPlan = configuredProviders.length > 0 || planner.backends.some((b) => b.usable);

  const plannerIsHarness = planner.backends.find((b) => b.id === planner.provider)?.kind === 'harness';

  const runnerLabelMap = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const r of displayRunners) m[r.id] = r.displayName;
    return m;
  }, [displayRunners]);

  const runningCount = useMemo(() =>
    plan?.tasks.filter((t) => t.status === 'in_progress').length ?? 0,
    [plan],
  );

  const doneCount = useMemo(() =>
    plan?.tasks.filter((t) => t.status === 'completed').length ?? 0,
    [plan],
  );

  const pendingEditCount = pendingEdits.length;

  const hasContent = blocks.length > 0 || isResearchActive || isExecuting || !!error;
  const streaming = blocks.some((b) => (b.type === 'message' || b.type === 'thinking') && b.streaming);
  /** The one usage block, drawn pinned below the conversation rather than scrolling in it. */
  const usageBlock = useMemo(() => blocks.find((b) => b.type === 'usage'), [blocks]);
  const hasDetail = useMemo(() => hasHiddenDetail(blocks), [blocks]);

  /**
   * The plan, mounted once. Not a timeline entry: it is the live control surface
   * (status, streaming output, checkpoint approval, Execute/Stop), and a control
   * surface pinned at a historical scroll position is one the user cannot find
   * when it changes. The chat carries a chip per revision instead.
   *
   * The inner markup is deliberately unchanged from when this lived in a chat
   * bubble — `.plan-dock-body` is added to the bubble's own CSS rules rather than
   * restyled, so the task-card arrangement is pixel-identical.
   */
  const renderPlanDock = () => {
    if (!plan || plan.tasks.length === 0) return null;
    return (
      <div className={`plan-dock ${dockExpanded ? 'expanded' : 'collapsed'}`}>
        {dockExpanded && <DockResizeHandle bodyRef={dockBodyRef} listRef={messageListRef} onCommit={handleDockResize} />}
        <button
          type="button"
          className="plan-dock-bar"
          onClick={() => setDockExpanded((v) => nextDock(v, v ? 'user-collapsed' : 'user-expanded'))}
          title={dockExpanded ? 'Collapse the plan' : 'Expand the plan'}
        >
          <span className={`plan-dock-chevron${dockExpanded ? '' : ' collapsed'}`}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M2 4L5.5 7.5L9 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="plan-dock-title">Plan</span>
          <span className="plan-dock-summary">{planSummaryLabel(plan.tasks)}</span>
          {/* A collapse is always honoured, including mid-run — so the bar has to
              say when a task is blocked on the user, or the approval would sit
              unseen behind it. */}
          {checkpoint && <span className="plan-dock-approval">1 awaiting approval</span>}
        </button>
        <div
          className="plan-dock-body"
          hidden={!dockExpanded}
          ref={dockBodyRef}
          style={dockHeight === undefined ? undefined : { maxHeight: dockHeight }}
        >
          {checkpoint && (
            <CheckpointPanel
              taskTitle={checkpoint.taskTitle}
              summary={checkpoint.summary}
              pausedAt={checkpoint.pausedAt}
              onApprove={handleApproveCheckpoint}
              onReject={handleRejectCheckpoint}
            />
          )}
          <PlanCardGroup
            tasks={plan.tasks}
            models={models}
            modelsByRunner={modelsByRunner}
            modesByRunner={modesByRunner}
            isExecuting={isExecuting}
            taskOutput={taskOutput}
            taskIdle={taskIdle}
            taskApprovals={taskApprovals}
            runnerLabels={runnerLabelMap}
            runners={runnerList}
            onRunnerChange={handleRunnerChange}
            onDependenciesChange={handleDependenciesChange}
            onAddTask={handleAddTask}
            onModelChange={handleModelChange}
            onModelsRefreshNeeded={handleModelsRefreshNeeded}
            onModeChange={handleModeChange}
            onOpsChange={handleOpsChange}
            mergeGates={taskGates}
            onRemoveTask={handleRemoveTask}
            onPromptChange={handlePromptChange}
            onRetry={handleRetry}
            onSkip={handleSkip}
            onCancel={handleCancel}
            onForceStart={handleForceStart}
            onMarkComplete={handleMarkComplete}
            onMarkIncomplete={handleMarkIncomplete}
            onMerge={handleMergeTasks}
            onSplit={handleSplitTask}
            onExecutePlan={handleExecutePlan}
            onStopExecution={handleStopExecution}
            onRunTask={handleRunTask}
            isolationByTask={taskIsolation}
            onResolveConflict={handleResolveConflict}
            onOpenLog={handleOpenTaskLog}
          />
          {handoff && !mergeGate && (
            <HandoffCard
              repos={handoff.repos}
              landed={handoff.landed}
              mergeResult={mergeResult}
              onAction={(action) => handleIsolationAction(action)}
            />
          )}
          {mergeGate && (
            <HandoffCard
              repos={mergeGate.repos}
              landed={mergeGate.landed}
              mergeResult={mergeResult}
              midRun={{ paused: mergeGate.paused }}
              onAction={(action) => handleIsolationAction(action)}
            />
          )}
          {isExecuting && (
            <div className="executing-footer">
              <div className="queue-badge done-counter">
                <span className="done-counter-check">✓</span> {doneCount}/{plan.tasks.length} done
              </div>
              {runningCount > 0 && (
                <div className="queue-badge executing">
                  <span className="queue-dot running" /> {runningCount} running
                </div>
              )}
              {pendingEditCount > 0 && (
                <div className="queue-badge">
                  <span className="queue-dot" /> {pendingEditCount} plan edit{pendingEditCount > 1 ? 's' : ''} pending
                </div>
              )}
              <div className="executing-status">Tasks active &mdash; plan edits apply between batches</div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <DetailContext.Provider value={detail}>
    <div className="chat-container">
      <div className="setup-panel">
        <button
          type="button"
          className="setup-panel-toggle"
          onClick={() => setSetupCollapsed((v) => !v)}
          title={setupCollapsed ? 'Expand settings' : 'Collapse settings'}
        >
          <span className="setup-panel-toggle-row">
            <span className="setup-panel-toggle-label">Settings</span>
            <span className={`setup-panel-chevron${setupCollapsed ? ' collapsed' : ''}`}>
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M2 4L5.5 7.5L9 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </span>
          {setupCollapsed && (
            <span className="setup-panel-summary">
              {planner.backends.find((b) => b.id === planner.provider)?.label || 'No planner'}
              {' · '}
              {runners.length} runner{runners.length === 1 ? '' : 's'}
            </span>
          )}
        </button>
        <div className={`setup-panel-body${setupCollapsed ? ' collapsed' : ''}`}>
        {planner.backends.length > 0 && (
          <section className="setup-block">
            <div className="setup-block-title">Planner</div>
            <div className="setup-block-hint">
              Researches your codebase and writes the plan. A coding agent plans on its own
              subscription — no API key needed.
            </div>
            <div className="planner-backends">
              {planner.backends.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={`planner-pill ${b.id === planner.provider ? 'active' : ''} ${b.usable ? '' : 'unusable'}`}
                  disabled={!b.usable}
                  title={b.reason}
                  onClick={() => handlePlannerChange(b.id)}
                >
                  {b.label}
                </button>
              ))}
            </div>
            {/* A harness planner has no API provider to filter by, and its models
                are never in the vendor mapping — passing either would empty the
                list behind a pill bar that cannot apply to it. */}
            <ModelSelector
              models={orchestratorModels}
              currentModel={orchestratorCurrentModel}
              configuredProviders={planner.runner ? [] : configuredProviders}
              modelApiMapping={planner.runner ? {} : orchestratorModelApiMapping}
              onChange={handleOrchestratorModelChange}
              label={planner.runner ? 'Model & thinking effort' : 'Model'}
            />
            {orchestratorModels.length === 0 && (
              <div className="model-discovery-error" role="alert">
                {planner.runner
                  ? <>No models discovered for this agent yet — run <code>/refresh</code>.</>
                  : <>No models available — add an API key with <code>/key set</code>, or pick a coding agent above.</>}
              </div>
            )}
            {Object.keys(modelDiscoveryErrors).length > 0 && !planner.runner && (
              <div className="model-discovery-error" role="alert">
                ⚠ Couldn't load models for{' '}
                {Object.entries(modelDiscoveryErrors)
                  .map(([p, msg]) => `${API_PROVIDER_LABELS[p as keyof typeof API_PROVIDER_LABELS] ?? p} (${msg})`)
                  .join('; ')}
                . Check the API key / base URL — those models are omitted.
              </div>
            )}
          </section>
        )}

        <section className="setup-block">
          <div className="setup-block-title">Runners</div>
          <div className="setup-block-hint">
            Coding agents that execute the plan's tasks. Toggle which ones the planner may assign.
          </div>
          <div className="runner-pills">
            {visibleRunners.map((r) => {
              const isToggled = runners.includes(r.id);
              return (
                <button key={r.id} className={`runner-pill ${isToggled ? 'on' : 'off'}`}
                  onClick={() => handleToggleRunner(r.id)}
                  title={`${isToggled ? 'Stop assigning' : 'Assign'} tasks to ${r.displayName}`}>
                  <span className="runner-dot" /> {r.displayName}
                </button>
              );
            })}
            {visibleRunners.length === 0 && (
              <span className="setup-block-empty">
                No coding agent detected — install Claude Code, Codex or OpenCode, then run <code>/refresh</code>.
              </span>
            )}
          </div>
        </section>
        </div>
      </div>

      <div className="skill-bar">
        <button className={`skill-toggle-pill ${tddEnabled ? 'on' : 'off'}`}
          onClick={() => handleToggleSkill('tdd')} title="TDD: test-driven development prompt augmentation">
          <span className="skill-toggle-dot" /> TDD
        </button>
        <button className={`skill-toggle-pill ${verifyEnabled ? 'on' : 'off'}`}
          onClick={() => handleToggleSkill('verify')} title="Verify (run tests): adds a final evidence-based task that runs the full suite, writes missing spec checks, and must exit green">
          <span className="skill-toggle-dot" /> Verify
        </button>
        <button className={`skill-toggle-pill ${runnerTransport === 'structured' ? 'on' : 'off'}`}
          onClick={handleToggleTransport} title="Structured: drive tasks through each runner's protocol instead of a terminal. Switch it off to use a terminal. Applies from the next run; a runner without a structured connector keeps its terminal.">
          <span className="skill-toggle-dot" /> Structured
        </button>
      </div>

      {hasDetail && (
        <div className="chat-header">
          <button
            type="button"
            className="detail-toggle"
            aria-pressed={detailAll}
            onClick={() => setDetailAll((v) => !v)}
            title="Show or hide the full thinking, command and subagent detail for the whole conversation"
          >
            {detailAll ? 'Collapse all' : 'Expand all'}
          </button>
        </div>
      )}

      {showModelInfo && (
        <div className="model-info-panel">
          <div className="model-info-title">Model Configuration</div>
          {/* Only a vendor planner is blocked by an unset model. A harness
              planner falls back to the coding agent's own default, so the same
              state is a working setup there — not a warning. */}
          {!modelConfig?.orchestrator && (
            plannerIsHarness ? (
              <div className="model-info-row">
                <span className="model-info-key">Model</span>
                <span className="model-info-val"><em>the agent's default</em></span>
              </div>
            ) : (
              <div className="model-info-warning">
                No orchestrator model selected. Type <code>/model set</code> to pick one, or plans cannot be generated.
              </div>
            )
          )}
          <div className="model-info-row">
            <span className="model-info-key">Orchestrator</span>
            <span className="model-info-val">{modelConfig?.orchestrator || <em>not set</em>}</span>
            {modelConfig?.orchestratorProvider && <span className="model-info-provider">via {modelConfig.orchestratorProvider}</span>}
          </div>
          <div className="model-info-footer">/model set to change · /key set to set an API key · /model to close</div>
        </div>
      )}

      {slashOutput && (
        <div className="slash-output">{slashOutput}</div>
      )}

      {showNewSessionConfirm && (
        <div className="new-session-confirm">
          <div className="new-session-confirm-text">
            Start a new session? Current plan generation will be stopped.
          </div>
          <div className="new-session-confirm-actions">
            <button className="btn-accept" onClick={() => {
              setShowNewSessionConfirm(false);
              handleNewSession();
            }}>New Session</button>
            <button className="btn-reject" onClick={() => setShowNewSessionConfirm(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="message-list" ref={messageListCallbackRef}>
        {!hasContent && !isReady && (
          <div className="loading-state">
            <div className="loading-pulse" />
            <p>Loading…</p>
          </div>
        )}

        {!hasContent && isReady && !canPlan && (
          <GetStarted onConfigure={handleConfigureApiKey} />
        )}

        {!hasContent && isReady && canPlan && (
          <EmptyState onLoadSession={handleLoadSession} />
        )}

        {error && (
          <div className="error-state">
            <div className="error-icon">!</div>
            <p className="error-message">{error}</p>
            <button onClick={() => setError('')}>Try Again</button>
          </div>
        )}

        <ConversationBlocks
          blocks={blocks}
          detailAll={detailAll}
          onShowPlan={handleShowPlan}
          onResolveApproval={handleResolveApproval}
        />

        <QueuedPrompts prompts={held} onUnsend={handleUnsend} />

        {isResearchActive && !streaming && (
          <div className="chat-msg-working">
            <span className="chat-msg-spinner" /> Working&hellip;
          </div>
        )}
      </div>

      {renderPlanDock()}

      {usageBlock && <UsageLine block={usageBlock} />}

      {stopArmed && <div className="stop-hint" role="status">Press Esc again to stop</div>}

      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        onEscape={handleEscape}
        disabled={conversationBusy}
        disabledReason={conversationBusy ? 'Compacting the conversation...' : undefined}
        placeholder={getPlaceholder()}
        modelOptions={modelOptions}
        harnessPlannerModels={harnessPlannerModels}
        configuredProviders={configuredProviders}
        isProcessing={isGenerating}
        pendingEdits={pendingEdits}
        onRemovePendingEdit={handleRemovePendingEdit}
        unsent={unsent}
        skills={skills}
      />
    </div>
    </DetailContext.Provider>
  );
}
