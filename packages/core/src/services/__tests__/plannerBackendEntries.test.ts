import { describe, it, expect } from 'vitest';
import { plannerBackendEntries, HARNESS_PLANNER_REASON, type PlannerUsability } from '../ProviderRegistry';

describe('plannerBackendEntries', () => {
  it('lists harness planners first, then configured vendors in PROVIDER_PRIORITY order', () => {
    const entries = plannerBackendEntries({}, ['anthropic', 'openrouter']);
    expect(entries.map((e) => e.id)).toEqual([
      'claude-code', 'codex', 'opencode', 'openrouter', 'anthropic',
    ]);
    expect(entries.map((e) => e.kind)).toEqual([
      'harness', 'harness', 'harness', 'vendor', 'vendor',
    ]);
  });

  it('labels harness planners with the no-key reason and their runner when usable', () => {
    const usable = (): PlannerUsability => ({ usable: true });
    const entries = plannerBackendEntries(
      { 'claude-code': usable(), codex: usable(), opencode: usable() },
      [],
    );
    const claude = entries[0];
    expect(claude).toMatchObject({
      id: 'claude-code', label: 'Claude Code', kind: 'harness',
      runner: 'claude-code', usable: true, reason: HARNESS_PLANNER_REASON,
    });
    expect(entries.map((e) => e.runner)).toEqual(['claude-code', 'codex', 'opencode']);
  });

  it('keeps an unusable harness planner listed with the reason it was given', () => {
    const entries = plannerBackendEntries(
      { codex: { usable: false, reason: 'codex is not installed or is not on PATH.' } },
      [],
    );
    const codex = entries.find((e) => e.id === 'codex')!;
    expect(codex).toMatchObject({ usable: false, reason: 'codex is not installed or is not on PATH.' });
  });

  it('treats a runner absent from the usability map as unusable', () => {
    const codex = plannerBackendEntries({}, []).find((e) => e.id === 'codex')!;
    expect(codex.usable).toBe(false);
  });

  it('offers vendors with their API-key variable as the reason, always usable', () => {
    const vendors = plannerBackendEntries({}, ['openrouter', 'google'])
      .filter((e) => e.kind === 'vendor');
    expect(vendors).toEqual([
      { id: 'openrouter', label: 'OpenRouter', kind: 'vendor', usable: true, reason: 'OPENROUTER_API_KEY' },
      { id: 'google', label: 'Google Gemini', kind: 'vendor', usable: true, reason: 'GEMINI_API_KEY' },
    ]);
  });

  it('lists only the harness planners when nothing is configured', () => {
    const entries = plannerBackendEntries({}, []);
    expect(entries.every((e) => e.kind === 'harness')).toBe(true);
    expect(entries).toHaveLength(3);
  });
});
