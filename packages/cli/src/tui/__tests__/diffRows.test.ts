import { describe, it, expect, afterEach } from 'vitest';
import { replayTaskLog, type TaskLogEvent } from '@ordewell/core';
import { conversationLines } from '../blocks';
import { stripAnsi, style } from '../ansi';

const SUM = '@@ -1,3 +1,3 @@\n export function sum(a, b) {\n-  return a - b;\n+  return a + b;\n }\n';

function edited(output: string, name = 'Update'): TaskLogEvent[] {
  return [
    { type: 'turn_start', message: 'fix it' },
    { type: 'tool_call', id: 'c1', name, args: '{"path":"src/sum.ts"}' },
    { type: 'tool_result', id: 'c1', output, success: true },
  ];
}

function rowsOf(events: TaskLogEvent[], cols: number, detailAll = false): string[] {
  const lines = conversationLines(replayTaskLog(events).blocks, cols, detailAll).map((line) => stripAnsi(line).trimEnd());
  const start = lines.findIndex((line) => line.startsWith('●'));
  const end = lines.indexOf('', start);
  return lines.slice(start, end < 0 ? undefined : end);
}

describe('a file edit\'s row', () => {
  afterEach(() => { style.enabled = false; });

  it('says what the edit changed, then its lines numbered and marked + and -', () => {
    expect(rowsOf(edited(SUM), 60)).toEqual([
      '● Update(src/sum.ts)',
      '  ⎿  Added 1 line, removed 1 line',
      '     1   export function sum(a, b) {',
      '     2 -   return a - b;',
      '     2 +   return a + b;',
      '     3   }',
    ]);
  });

  it('paints an added line green and a removed line red', () => {
    style.enabled = true;
    const lines = conversationLines(replayTaskLog(edited(SUM)).blocks, 60, false);
    expect(lines.find((line) => stripAnsi(line).includes('+   return'))).toContain('\x1b[32m');
    expect(lines.find((line) => stripAnsi(line).includes('-   return'))).toContain('\x1b[31m');
  });

  it('previews a long diff and counts what the preview leaves out, all of it in full detail', () => {
    const body = Array.from({ length: 30 }, (_, i) => `+line ${i + 1}`).join('\n');
    const collapsed = rowsOf(edited(body, 'Write'), 60);
    expect(collapsed[1]).toBe('  ⎿  Added 30 lines');
    expect(collapsed.at(-1)).toBe('     … +20 lines (ctrl+o to expand)');
    expect(collapsed).toHaveLength(2 + 10 + 1);

    const detailed = rowsOf(edited(body, 'Write'), 60, true);
    expect(detailed).toContain('     30 + line 30');
    expect(detailed[1]).toBe('  ⎿  Added 30 lines');
    expect(detailed.some((line) => line.includes('ctrl+o to expand'))).toBe(false);
  });

  it('marks the lines between two hunks, numbers right-aligned as an editor sets them', () => {
    const rows = rowsOf(edited('@@ -1 +1 @@\n-a\n+A\n@@ -40 +40 @@\n-b\n+B\n'), 60);
    expect(rows.slice(2)).toEqual([
      '      1 - a',
      '      1 + A',
      '        ⋮',
      '     40 - b',
      '     40 + B',
    ]);
  });
});
