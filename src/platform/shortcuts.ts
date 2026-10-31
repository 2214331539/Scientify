export type ShortcutScope = 'global' | 'editor' | 'assistant';

export type ShortcutCommand =
  | 'app.openAssistant'
  | 'app.openNotes'
  | 'app.openLiterature'
  | 'app.openExperiments'
  | 'app.openCode'
  | 'app.focusSearch'
  | 'app.newConversation'
  | 'editor.bold'
  | 'editor.italic'
  | 'editor.save'
  | 'editor.find'
  | 'assistant.send'
  | 'assistant.stop';

export type ShortcutBinding = {
  command: ShortcutCommand;
  keys: string;
  enabled: boolean;
};

export type ShortcutSettings = { bindings: ShortcutBinding[] };

export const SHORTCUT_COMMANDS: ReadonlyArray<{
  command: ShortcutCommand;
  scope: ShortcutScope;
  label: string;
  description: string;
}> = [
  {
    command: 'app.openAssistant',
    scope: 'global',
    label: '打开 AI 助手',
    description: '显示或聚焦侧边栏 AI 助手。',
  },
  {
    command: 'app.openNotes',
    scope: 'global',
    label: '打开笔记',
    description: '切换到当前项目的笔记工作区。',
  },
  {
    command: 'app.openLiterature',
    scope: 'global',
    label: '打开文献库',
    description: '切换到当前项目的文献工作区。',
  },
  {
    command: 'app.openExperiments',
    scope: 'global',
    label: '打开实验',
    description: '切换到当前项目的实验工作区。',
  },
  {
    command: 'app.openCode',
    scope: 'global',
    label: '打开代码',
    description: '打开当前实验的代码文件。',
  },
  {
    command: 'app.focusSearch',
    scope: 'global',
    label: '全局搜索',
    description: '打开项目、文献和笔记搜索。',
  },
  {
    command: 'app.newConversation',
    scope: 'global',
    label: '新建 AI 会话',
    description: '在 AI 助手中创建独立会话。',
  },
  {
    command: 'editor.bold',
    scope: 'editor',
    label: '加粗',
    description: '在 Markdown 编辑器中加粗选中文本。',
  },
  {
    command: 'editor.italic',
    scope: 'editor',
    label: '斜体',
    description: '在 Markdown 编辑器中设置斜体。',
  },
  {
    command: 'editor.save',
    scope: 'editor',
    label: '保存文件',
    description: '保存当前笔记或代码文件。',
  },
  {
    command: 'editor.find',
    scope: 'editor',
    label: '查找',
    description: '在当前编辑器中查找文本。',
  },
  {
    command: 'assistant.send',
    scope: 'assistant',
    label: '发送消息',
    description: '发送当前 AI 输入。',
  },
  {
    command: 'assistant.stop',
    scope: 'assistant',
    label: '中止任务',
    description: '中止当前 AI 任务。',
  },
];

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  bindings: [
    ['app.openAssistant', 'Mod+Shift+L'],
    ['app.openNotes', 'Mod+Shift+O'],
    ['app.openLiterature', 'Mod+Shift+R'],
    ['app.openExperiments', 'Mod+Shift+E'],
    ['app.openCode', 'Mod+Shift+P'],
    ['app.focusSearch', 'Mod+K'],
    ['app.newConversation', 'Mod+Shift+N'],
    ['editor.bold', 'Mod+B'],
    ['editor.italic', 'Mod+I'],
    ['editor.save', 'Mod+S'],
    ['editor.find', 'Mod+F'],
    ['assistant.send', 'Mod+Enter'],
    ['assistant.stop', 'Escape'],
  ].map(([command, keys]) => ({ command: command as ShortcutCommand, keys, enabled: true })),
};

function cleanKey(key: string) {
  const value = key.trim();
  if (!value) return '';
  const aliases: Record<string, string> = {
    control: 'Ctrl',
    ctrl: 'Ctrl',
    command: 'Meta',
    cmd: 'Meta',
    option: 'Alt',
    esc: 'Escape',
    spacebar: 'Space',
    ' ': 'Space',
    return: 'Enter',
  };
  return (
    aliases[value.toLowerCase()] ??
    (value.length === 1 ? value.toUpperCase() : value[0].toUpperCase() + value.slice(1))
  );
}

/** Converts user-entered variants into a stable, comparable form. */
export function normalizeShortcut(value: string) {
  const parts = value.split('+').map(cleanKey).filter(Boolean);
  const modifiers = new Set(parts.slice(0, -1).map((part) => (part === 'Meta' ? 'Mod' : part)));
  const key = cleanKey(parts.at(-1) ?? '');
  const ordered = ['Mod', 'Ctrl', 'Alt', 'Shift'].filter((part) => modifiers.has(part));
  return [...ordered, key].filter(Boolean).join('+');
}

export function formatShortcut(value: string) {
  const normalized = normalizeShortcut(value);
  if (!normalized) return '未设置';
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return normalized
    .split('+')
    .map((part) => (part === 'Mod' ? (isMac ? '⌘' : 'Ctrl') : part === 'Alt' && isMac ? '⌥' : part))
    .join(isMac ? '' : ' + ');
}

export function eventToShortcut(event: KeyboardEvent) {
  if (event.isComposing) return '';
  const modifiers = [
    event.metaKey || event.ctrlKey ? 'Mod' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
  ].filter(Boolean);
  let key = event.key;
  if (key === ' ') key = 'Space';
  if (key === 'Esc') key = 'Escape';
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(key)) return '';
  return normalizeShortcut([...modifiers, key].join('+'));
}

export function isEditableTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return !!element.closest('input, textarea, select, [contenteditable="true"], .cm-editor');
}

export function bindingFor(settings: ShortcutSettings | undefined, command: ShortcutCommand) {
  const custom = settings?.bindings.find((binding) => binding.command === command);
  return custom ?? DEFAULT_SHORTCUTS.bindings.find((binding) => binding.command === command);
}

export function detectShortcutConflicts(bindings: ShortcutBinding[]) {
  const conflicts = new Set<string>();
  const seen = new Map<string, ShortcutBinding>();
  for (const binding of bindings) {
    if (!binding.enabled) continue;
    const keys = normalizeShortcut(binding.keys);
    if (!keys) continue;
    const previous = seen.get(keys);
    if (previous) {
      conflicts.add(previous.command);
      conflicts.add(binding.command);
    } else seen.set(keys, binding);
  }
  return conflicts;
}

export function shortcutToCodeMirror(value: string) {
  return normalizeShortcut(value)
    .split('+')
    .map((part) => (part === 'Mod' ? 'Mod' : part.toLowerCase()))
    .reverse()
    .join('-');
}

export function cloneShortcutSettings(settings?: ShortcutSettings): ShortcutSettings {
  const byCommand = new Map(
    (settings?.bindings ?? []).map((binding) => [binding.command, binding]),
  );
  return {
    bindings: DEFAULT_SHORTCUTS.bindings.map((binding) => ({
      ...binding,
      ...(byCommand.get(binding.command) ?? {}),
      keys: normalizeShortcut(byCommand.get(binding.command)?.keys ?? binding.keys),
    })),
  };
}
