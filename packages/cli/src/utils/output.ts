import { taskStatusKind } from '@ordewell/core';

export function iconFor(status: string): string {
  switch (taskStatusKind({ status })) {
    case 'done': return '\x1b[32m✓\x1b[0m';
    case 'running':
    case 'quiet': return '\x1b[34m⟳\x1b[0m';
    case 'failed': return '\x1b[31m✗\x1b[0m';
    case 'blocked': return '\x1b[33m⊘\x1b[0m';
    case 'awaiting': return '\x1b[33m?\x1b[0m';
    case 'todo': return '\x1b[90m○\x1b[0m';
  }
}
