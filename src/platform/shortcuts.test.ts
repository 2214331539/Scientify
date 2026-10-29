import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  detectShortcutConflicts,
  eventToShortcut,
  isEditableTarget,
  normalizeShortcut,
} from './shortcuts';

describe('shortcuts', () => {
  it('normalizes modifier order and aliases', () => {
    expect(normalizeShortcut('shift + ctrl + k')).toBe('Ctrl+Shift+K');
    expect(normalizeShortcut('cmd+shift+p')).toBe('Mod+Shift+P');
    expect(normalizeShortcut('escape')).toBe('Escape');
  });

  it('converts keyboard events to the cross-platform Mod form', () => {
    expect(eventToShortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))).toBe(
      'Mod+K',
    );
    expect(eventToShortcut(new KeyboardEvent('keydown', { key: 'b', metaKey: true }))).toBe(
      'Mod+B',
    );
    expect(eventToShortcut(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))).toBe(
      '',
    );
  });

  it('detects duplicate bindings and ignores disabled commands', () => {
    const bindings = DEFAULT_SHORTCUTS.bindings.map((binding) => ({ ...binding }));
    bindings[0] = { ...bindings[0], keys: 'Mod+K' };
    const conflicts = detectShortcutConflicts(bindings);
    expect(conflicts.has('app.openAssistant')).toBe(true);
    expect(conflicts.has('app.focusSearch')).toBe(true);
    bindings[0] = { ...bindings[0], enabled: false };
    expect(detectShortcutConflicts(bindings).has('app.openAssistant')).toBe(false);
  });

  it('recognizes editable targets so global navigation does not steal typing', () => {
    const input = document.createElement('input');
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    document.body.append(input, editor);
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(editor)).toBe(true);
    expect(isEditableTarget(document.body)).toBe(false);
  });
});
