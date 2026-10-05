import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { OrdewellMcpServer } from '../mcp';
import type { SessionRuntimeSettings } from '../createSession';
import type { DiscoveredModel } from '../../models/Task';
import type { SessionMessage } from '../SessionMessage';
import { fakeConfig, makeSession } from './sessionTestKit';

/**
 * The opt-in live check for the Claude Code planner's Ordewell tools
 * (ADR-0022): the real CLI in plan mode, the real server, a real Session.
 *
 *   ORDEWELL_LIVE_AGENTS=claude-code npx vitest run --root packages/core plannerToolsLive
 *
 * Not part of the suite: it costs real tokens and a minute or two.
 */

const live = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).includes('claude-code');

const CATALOG: Record<string, DiscoveredModel[]> = {
  'claude-code': [{ modelId: 'sonnet', modelLabel: 'Sonnet', variants: [] }],
  codex: [{ modelId: 'gpt-5', modelLabel: 'GPT-5', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] }],
};

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const undo of cleanup.splice(0).reverse()) await undo(); });

describe.runIf(live)('Claude Code planner tools — live', () => {
  it('reads a runner enabled mid-conversation and commits a plan on it through submit_plan (#69)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-planner-tools-'));
    cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
    const server = new OrdewellMcpServer();
    cleanup.push(() => server.dispose());
    const config = fakeConfig({ aiProvider: 'claude-code', orchestratorModel: 'sonnet' });
    const ai = new CliAgentAiService(config, { spawn, workspaceRoot: () => workspace, mcpServer: server });
    cleanup.push(() => ai.reset());

    let settings: SessionRuntimeSettings = { tddEnabled: false, enabledRunners: ['claude-code'] };
    const toolCalls: string[] = [];
    const broadcast = vi.fn((msg: SessionMessage) => {
      if (msg.type === 'research_step' && msg.toolLabel) toolCalls.push(msg.toolLabel);
    });
    const session = makeSession({
      config,
      aiService: ai,
      mcpServer: server,
      workspaceRoot: () => workspace,
      modelResolver: { modelsForRunners: vi.fn(async (runners: string[]) => Object.fromEntries(runners.map((r) => [r, CATALOG[r] ?? []]))) },
      settings: () => settings,
      broadcast,
    });

    await session.startPlanning(
      'This is a test of the planning tools, in an empty directory: do not explore it. '
      + 'Goal: add a hello-world script and a test for it. Ask me which runners to use, and stop there.',
      ['claude-code'],
    );
    expect(ai.plannerToolsAttached()).toBe(true);
    expect(session.planTasks).toEqual([]);

    settings = { ...settings, enabledRunners: ['claude-code', 'codex'] };
    await session.continueConversation(
      'I just enabled codex. Skip the outline: submit the plan now, exactly two AFK ai tasks — '
      + 'the script on codex, and the test on claude-code, depending on the script.',
    );

    console.log('planner tool calls:', toolCalls.join(', '));
    console.log('committed:', JSON.stringify(session.planTasks.map((t) => [t.title, t.assignedRunner, t.assignedModel?.modelId, t.taskMode])));
    expect(toolCalls).toEqual(expect.arrayContaining(['mcp__ordewell__list_runners', 'mcp__ordewell__submit_plan']));
    expect(session.planTasks.map((t) => t.assignedRunner).sort()).toEqual(['claude-code', 'codex']);
    expect(session.planState?.runners).toEqual(['claude-code', 'codex']);
  }, 600_000);
});
