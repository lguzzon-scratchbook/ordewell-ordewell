import { describe, it, expect } from 'vitest';
import { outputPreview, toolHeadline, diffRows, diffSummary } from '../format';

describe('toolHeadline', () => {
  it('heads a shell call with its command', () => {
    expect(toolHeadline('bash', JSON.stringify({ command: 'npm test -- --run' }))).toEqual({ name: 'Bash', keyArg: 'npm test -- --run' });
  });

  it('keeps a multi-line command\'s first line and says how many more follow', () => {
    const command = '\ncat <<EOF > notes.txt\nfirst\nsecond\nEOF\n';

    expect(toolHeadline('bash', JSON.stringify({ command })).keyArg).toBe('cat <<EOF > notes.txt … +3 lines');
  });

  it.each([
    ['read_file', { path: 'src/models/Task.ts', limit: 2000 }, undefined, 'Read', 'src/models/Task.ts'],
    ['read_files', { paths: ['a.ts', 'b.ts'] }, undefined, 'Read', 'a.ts, b.ts'],
    ['list_dir', { path: 'packages', depth: 2 }, undefined, 'List', 'packages'],
    ['glob', { pattern: '**/*.test.ts', path: 'packages/core' }, undefined, 'Glob', '**/*.test.ts in packages/core'],
    ['glob', { pattern: '*.md' }, undefined, 'Glob', '*.md'],
    ['grep', { pattern: 'reduce\\(', path: 'packages/cli', include: '*.ts' }, undefined, 'Grep', 'reduce\\( in packages/cli (*.ts)'],
    ['grep', { pattern: 'TODO' }, undefined, 'Grep', 'TODO'],
    ['find_symbol', { symbol: 'PlanStore', language: 'typescript' }, undefined, 'Symbol', 'PlanStore [typescript]'],
    ['fetch', { url: 'https://example.com/docs' }, undefined, 'Fetch', 'https://example.com/docs'],
    ['web_search', { query: 'vitest  fake\ntimers' }, undefined, 'WebSearch', 'vitest fake timers'],
    ['spawn_research_agent', { prompt: '  Map the approval seam.\nReport every caller.' }, undefined, 'Agent', 'Map the approval seam. Report every caller.'],
    // A harness planner's own tools, named as the agent names them (ADR-0009).
    ['read_file', { file_path: '/repo/README.md', path: '/repo/README.md' }, 'Read', 'Read', '/repo/README.md'],
    ['bash', { command: 'git status' }, 'exec_command', 'exec_command', 'git status'],
    ['agent_tool', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }, 'Edit', 'Edit', 'src/a.ts'],
    ['agent_tool', { filePath: 'src/b.ts', content: '…' }, 'write', 'write', 'src/b.ts'],
    ['agent_tool', { description: 'Survey the TUI', prompt: 'Read every file under tui/' }, 'Agent', 'Agent', 'Survey the TUI'],
    ['agent_tool', { url: 'https://example.com', prompt: 'summarize' }, 'WebFetch', 'WebFetch', 'https://example.com'],
  ])('heads %s with its main argument', (tool, args, toolLabel, name, keyArg) => {
    expect(toolHeadline(tool, JSON.stringify(args), toolLabel)).toEqual({ name, keyArg });
  });

  it('falls back to the first text argument of a tool it has no rule for, then to nothing', () => {
    expect(toolHeadline('agent_tool', JSON.stringify({ todos: [{ content: 'x' }], mode: 'merge' }), 'TodoWrite')).toEqual({ name: 'TodoWrite', keyArg: 'merge' });
    expect(toolHeadline('agent_tool', JSON.stringify({ todos: [] }), 'TodoWrite')).toEqual({ name: 'TodoWrite', keyArg: '' });
  });

  it('shows arguments that are not a JSON object as they came, on one line', () => {
    expect(toolHeadline('bash', 'ls -la\nsrc')).toEqual({ name: 'Bash', keyArg: 'ls -la src' });
    expect(toolHeadline('glob', '')).toEqual({ name: 'Glob', keyArg: '' });
  });
});

describe('outputPreview', () => {
  it('keeps the first lines and counts the rest', () => {
    expect(outputPreview('one\ntwo\nthree\nfour\nfive', 2)).toEqual({ lines: ['one', 'two'], hiddenLineCount: 3 });
  });

  it('does not count the blank lines a trailing newline leaves', () => {
    expect(outputPreview('one\ntwo\n', 5)).toEqual({ lines: ['one', 'two'], hiddenLineCount: 0 });
    expect(outputPreview('one\n\n  \n', 5)).toEqual({ lines: ['one'], hiddenLineCount: 0 });
  });

  it('splits CRLF and bare CR line endings like LF', () => {
    expect(outputPreview('one\r\ntwo\rthree\r\n', 5)).toEqual({ lines: ['one', 'two', 'three'], hiddenLineCount: 0 });
  });

  it('strips terminal escapes a command printed', () => {
    const colored = '\x1b[32m✓\x1b[0m 12 passed\n\x1b]8;;https://x.dev\x07link\x1b]8;;\x07\n\x1b[?25lhidden cursor\x1b[?25h';

    expect(outputPreview(colored, 5)).toEqual({ lines: ['✓ 12 passed', 'link', 'hidden cursor'], hiddenLineCount: 0 });
  });

  it('has nothing to show for empty output, and hides everything at zero lines', () => {
    expect(outputPreview('', 3)).toEqual({ lines: [], hiddenLineCount: 0 });
    expect(outputPreview('\n', 3)).toEqual({ lines: [], hiddenLineCount: 0 });
    expect(outputPreview('a\nb', 0)).toEqual({ lines: [], hiddenLineCount: 2 });
  });
});

describe('diffRows', () => {
  it('numbers each line from its hunk header: a removal by the old file, the rest by the new', () => {
    expect(diffRows('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -9 +9,2 @@\n x\n+y\n')).toEqual([
      { kind: 'context', line: 1, text: 'a' },
      { kind: 'removed', line: 2, text: 'b' },
      { kind: 'added', line: 2, text: 'B' },
      { kind: 'context', line: 3, text: 'c' },
      { kind: 'gap', text: '' },
      { kind: 'context', line: 9, text: 'x' },
      { kind: 'added', line: 10, text: 'y' },
    ]);
  });

  it('numbers a whole new file from its first line, and leaves out the no-newline note', () => {
    expect(diffRows('+hi\n+there\n\\ No newline at end of file\n')).toEqual([
      { kind: 'added', line: 1, text: 'hi' },
      { kind: 'added', line: 2, text: 'there' },
    ]);
  });
});

describe('diffSummary', () => {
  it('says what an edit added and removed, leaving out a side that is nothing', () => {
    expect(diffSummary({ added: 1, removed: 1 })).toBe('Added 1 line, removed 1 line');
    expect(diffSummary({ added: 2, removed: 0 })).toBe('Added 2 lines');
    expect(diffSummary({ added: 0, removed: 3 })).toBe('Removed 3 lines');
  });
});
