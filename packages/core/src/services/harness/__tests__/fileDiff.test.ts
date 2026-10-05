import { describe, it, expect } from 'vitest';
import { markedLines, hunksOf, structuredPatchText } from '../fileDiff';

describe('markedLines', () => {
  it('marks every line of a whole file, keeping its final newline as it was', () => {
    expect(markedLines('a\nb\n', '+')).toBe('+a\n+b\n');
    expect(markedLines('a\nb', '-')).toBe('-a\n-b');
  });

  it('leaves an empty file empty', () => {
    expect(markedLines('', '+')).toBe('');
  });
});

describe('hunksOf', () => {
  it('drops the file headers a unified diff opens with, keeping its hunks', () => {
    const unified = [
      'Index: /repo/README.md',
      '===================================================================',
      '--- /repo/README.md',
      '+++ /repo/README.md',
      '@@ -1,2 +1,3 @@',
      ' # Title',
      '+New line',
      ' end',
      '',
    ].join('\n');
    expect(hunksOf(unified)).toBe('@@ -1,2 +1,3 @@\n # Title\n+New line\n end\n');
  });

  it('drops every file\'s headers in a diff of several files, but not a removed line that looks like one', () => {
    const unified = [
      'Index: a.sql',
      '--- a.sql',
      '+++ a.sql',
      '@@ -1,2 +1,1 @@',
      '--- a comment',
      ' select 1;',
      'Index: b.txt',
      '--- b.txt',
      '+++ b.txt',
      '@@ -0,0 +1 @@',
      '+hi',
    ].join('\n');
    expect(hunksOf(unified)).toBe('@@ -1,2 +1,1 @@\n--- a comment\n select 1;\n@@ -0,0 +1 @@\n+hi');
  });

  it('keeps the no-newline note without counting it as a line of the hunk', () => {
    expect(hunksOf('--- a\n+++ a\n@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+y\n')).toBe('@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+y\n');
  });

  it('keeps text that has no hunk as it came', () => {
    expect(hunksOf('Edit applied successfully.')).toBe('Edit applied successfully.');
  });
});

describe('structuredPatchText', () => {
  it('writes each hunk under its range header, a one-line range without its count', () => {
    expect(structuredPatchText([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] },
      { oldStart: 9, oldLines: 1, newStart: 9, newLines: 2, lines: [' x', '+y'] },
    ])).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -9 +9,2 @@\n x\n+y\n');
  });

  it('is nothing for no hunks or a shape it does not know', () => {
    expect(structuredPatchText([])).toBe('');
    expect(structuredPatchText('nope')).toBe('');
    expect(structuredPatchText([{ lines: 'x' }])).toBe('');
  });
});
