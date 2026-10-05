import type { DiffStat, ToolHeadline } from './blocks';
import { ANSI_OR_CTRL_RE } from '../services/terminalRender';

/**
 * How a command row names an Ordewell research tool. A harness planner's call
 * keeps the agent's own name instead (`toolLabel`, ADR-0009), so the row says
 * which tool actually ran.
 */
const DISPLAY_NAMES: Record<string, string> = {
  read_file: 'Read',
  read_files: 'Read',
  list_dir: 'List',
  glob: 'Glob',
  grep: 'Grep',
  find_symbol: 'Symbol',
  bash: 'Bash',
  fetch: 'Fetch',
  web_search: 'WebSearch',
  spawn_research_agent: 'Agent',
};

// Tried in order for a tool with no rule of its own: the field that names what
// a call is about comes before the free text around it.
const HINT_FIELDS = ['file_path', 'filePath', 'path', 'url', 'pattern', 'query', 'command', 'description', 'prompt'] as const;

function parseArgs(args: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// A command's later lines can change what it does (a heredoc body, a chained
// step), so they are counted rather than folded into the first.
function firstLineOf(command: string): string {
  const lines = command.trim().split(/\r?\n/);
  const more = lines.length - 1;
  return more > 0 ? `${lines[0]} … +${more} line${more === 1 ? '' : 's'}` : lines[0];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function searchArg(pattern: string, path: string, include = ''): string {
  return `${pattern}${path ? ` in ${path}` : ''}${include ? ` (${include})` : ''}`;
}

function hintArg(args: Record<string, unknown>): string {
  for (const field of HINT_FIELDS) {
    const value = text(args[field]);
    if (value) return field === 'command' ? firstLineOf(value) : oneLine(value);
  }
  const firstText = Object.values(args).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return firstText ? oneLine(firstText) : '';
}

function keyArgOf(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'bash':
      return firstLineOf(text(args.command));
    case 'read_file':
    case 'list_dir':
      return text(args.path);
    case 'read_files':
      return Array.isArray(args.paths) ? args.paths.map(String).join(', ') : '';
    case 'glob':
      return searchArg(text(args.pattern), text(args.path));
    case 'grep':
      return searchArg(text(args.pattern), text(args.path), text(args.include));
    case 'find_symbol':
      return `${text(args.symbol)}${text(args.language) ? ` [${text(args.language)}]` : ''}`;
    case 'fetch':
      return text(args.url);
    case 'web_search':
      return oneLine(text(args.query));
    case 'spawn_research_agent':
      return oneLine(text(args.prompt));
    default:
      return hintArg(args);
  }
}

/**
 * The one-line head of a command row, shared by every surface: the tool's name
 * and the argument that says what the call is about.
 *
 * @param args The call's arguments as announced (JSON). Anything that is not a
 * JSON object is shown as it came, on one line.
 * @param toolLabel A harness planner's own name for the tool (ADR-0009).
 */
export function toolHeadline(tool: string, args: string, toolLabel?: string): ToolHeadline {
  const name = toolLabel?.trim() || DISPLAY_NAMES[tool] || tool;
  const parsed = parseArgs(args);
  return { name, keyArg: parsed ? keyArgOf(tool, parsed) : oneLine(args) };
}

export interface OutputPreview {
  lines: string[];
  hiddenLineCount: number;
}

/** The lines of a tool's output as a reader sees them — what {@link outputPreview} shows and counts. */
export function outputLines(output: string): string[] {
  // Line endings first: CR is itself a control character the escape pass drops.
  const lines = output.replace(/\r\n?/g, '\n').replace(ANSI_OR_CTRL_RE, '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

/** The head of a tool's output for a collapsed row, and how many lines it leaves out. */
export function outputPreview(output: string, maxLines: number): OutputPreview {
  const lines = outputLines(output);
  const shown = lines.slice(0, Math.max(0, maxLines));
  return { lines: shown, hiddenLineCount: lines.length - shown.length };
}

/**
 * The lines a diff adds and removes, or null when `output` is not one: every
 * line a hunk header, context, an addition or a removal, and at least one of
 * the last two.
 */
export function diffStat(output: string): DiffStat | null {
  const lines = outputLines(output);
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
    else if (!(line.startsWith('@@') || line.startsWith(' ') || line === '' || line.startsWith('\\'))) return null;
  }
  return added + removed > 0 ? { added, removed } : null;
}
