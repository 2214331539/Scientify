import { describe, expect, it } from 'vitest';
import { collaborationEntityId } from './collaboration';

describe('collaborationEntityId', () => {
  it('is stable and safe for server entity identifiers', () => {
    const first = collaborationEntityId('F:/experiments/main worktree:notes/结果.md');
    expect(first).toBe(collaborationEntityId('F:/experiments/main worktree:notes/结果.md'));
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.length).toBeLessThanOrEqual(160);
  });

  it('keeps distinct paths distinct after encoding', () => {
    expect(collaborationEntityId('base:script.py')).not.toBe(
      collaborationEntityId('base:script.py.bak'),
    );
  });
});
