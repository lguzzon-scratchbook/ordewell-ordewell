/**
 * A file edit's output in one shape for every runner: hunks under `@@` range
 * headers, with no file headers (the row already names the file), and a whole
 * added or deleted file as `+` or `-` lines. Surfaces draw that as a diff and
 * count it (`ToolBlock.diff`).
 */

/** Mark every line of a whole file, keeping its final newline as it was. */
export function markedLines(text: string, mark: '+' | '-'): string {
  if (!text) return text;
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return `${body.split('\n').map((line) => `${mark}${line}`).join('\n')}${body === text ? '' : '\n'}`;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * A unified diff's hunks, without the `Index:` / `---` / `+++` lines that open
 * each file. A hunk is read for as many lines as its header counts, so a
 * removed line that reads `--- …` stays. Text with no hunk comes back as it was.
 */
export function hunksOf(diff: string): string {
  const kept: string[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0 || line.startsWith('\\')) {
      kept.push(line);
      if (line.startsWith('\\')) continue;
      if (!line.startsWith('+')) oldLeft -= 1;
      if (!line.startsWith('-')) newLeft -= 1;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (!header) continue;
    kept.push(line);
    oldLeft = header[1] === undefined ? 1 : Number(header[1]);
    newLeft = header[2] === undefined ? 1 : Number(header[2]);
  }
  return kept.length ? `${kept.join('\n')}${diff.endsWith('\n') ? '\n' : ''}` : diff;
}

function range(start: number, lines: number): string {
  return lines === 1 ? `${start}` : `${start},${lines}`;
}

/** Claude Code's `structuredPatch`, written out as hunks. Anything not shaped like one is nothing. */
export function structuredPatchText(patch: unknown): string {
  if (!Array.isArray(patch)) return '';
  let text = '';
  for (const hunk of patch as unknown[]) {
    if (!hunk || typeof hunk !== 'object') return '';
    const { oldStart, oldLines, newStart, newLines, lines } = hunk as Record<string, unknown>;
    if (typeof oldStart !== 'number' || typeof oldLines !== 'number' || typeof newStart !== 'number' || typeof newLines !== 'number') return '';
    if (!Array.isArray(lines) || !lines.every((line): line is string => typeof line === 'string')) return '';
    text += `@@ -${range(oldStart, oldLines)} +${range(newStart, newLines)} @@\n${lines.map((line) => `${line}\n`).join('')}`;
  }
  return text;
}
