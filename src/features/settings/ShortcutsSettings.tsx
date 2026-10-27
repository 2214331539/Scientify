import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { Check, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '../../components/primitives';
import { t, translateError } from '../../i18n';
import type { WorkspaceStore } from '../../stores/workspace';
import {
  cloneShortcutSettings,
  detectShortcutConflicts,
  eventToShortcut,
  formatShortcut,
  normalizeShortcut,
  SHORTCUT_COMMANDS,
  type ShortcutBinding,
} from '../../platform/shortcuts';
import './shortcuts.css';

const SCOPES = ['global', 'editor', 'assistant'] as const;

export function ShortcutsSettings({
  store,
  onDirtyChange,
}: {
  store: WorkspaceStore;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const data = useStore(store, (state) => state.data);
  const [draft, setDraft] = useState<ShortcutBinding[]>(
    () => cloneShortcutSettings(data?.settings.shortcuts).bindings,
  );
  const [saved, setSaved] = useState<ShortcutBinding[]>(
    () => cloneShortcutSettings(data?.settings.shortcuts).bindings,
  );
  const [capturing, setCapturing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const conflicts = useMemo(() => detectShortcutConflicts(draft), [draft]);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setCapturing(null);
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        setDraft((current) =>
          current.map((item) => (item.command === capturing ? { ...item, keys: '' } : item)),
        );
        setCapturing(null);
        return;
      }
      const keys = eventToShortcut(event);
      if (!keys) return;
      setDraft((current) =>
        current.map((item) => (item.command === capturing ? { ...item, keys } : item)),
      );
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing]);

  useEffect(() => {
    if (!data) return;
    const next = cloneShortcutSettings(data.settings.shortcuts).bindings;
    if (!dirty) {
      setDraft(next);
      setSaved(next);
    }
  }, [data?.settings.shortcuts]);

  async function save() {
    if (conflicts.size) {
      setError(t('存在快捷键冲突，请先修改重复按键。'));
      return;
    }
    setError('');
    const next = draft.map((binding) => ({ ...binding, keys: normalizeShortcut(binding.keys) }));
    const ok = await store.getState().update((workspace) => {
      workspace.settings.shortcuts = { bindings: next };
    });
    if (ok) {
      setDraft(next);
      setSaved(next);
    } else setError(store.getState().error ?? t('保存失败，请重试。'));
  }

  function resetAll() {
    const next = cloneShortcutSettings().bindings;
    setDraft(next);
    setError('');
  }

  function resetOne(command: ShortcutBinding['command']) {
    const fallback = cloneShortcutSettings().bindings.find((item) => item.command === command);
    if (!fallback) return;
    setDraft((current) =>
      current.map((item) =>
        item.command === command ? { ...item, keys: fallback.keys, enabled: true } : item,
      ),
    );
  }

  return (
    <div className="settings-shortcuts">
      <div className="settings-shortcuts-intro">
        <div>
          <h3>{t('快捷键')}</h3>
          <p>
            {t(
              '像 VS Code、Typora 一样，在这里查看和编辑 Scientify 的快捷操作。输入框、代码编辑器和中文输入法会优先使用自己的快捷键。',
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          onClick={resetAll}
          disabled={!dirty && !draft.some((item) => !item.enabled)}
        >
          <RotateCcw size={14} aria-hidden="true" />
          {t('恢复默认')}
        </Button>
      </div>
      {SCOPES.map((scope) => (
        <section
          className="settings-shortcut-group"
          key={scope}
          aria-labelledby={`shortcut-${scope}`}
        >
          <h4 id={`shortcut-${scope}`}>
            {scope === 'global' ? t('全局') : scope === 'editor' ? t('编辑器') : t('AI 助手')}
          </h4>
          {SHORTCUT_COMMANDS.filter((item) => item.scope === scope).map((item) => {
            const binding = draft.find((value) => value.command === item.command)!;
            const conflict = conflicts.has(item.command);
            const label = t(item.label);
            return (
              <div
                className="settings-shortcut-row"
                key={item.command}
                data-conflict={conflict || undefined}
              >
                <div className="settings-shortcut-copy">
                  <strong>{label}</strong>
                  <span>{t(item.description)}</span>
                </div>
                <div className="settings-shortcut-actions">
                  {conflict ? <span className="settings-shortcut-warning">{t('冲突')}</span> : null}
                  <label className="settings-shortcut-enabled">
                    <input
                      type="checkbox"
                      checked={binding.enabled}
                      aria-label={t('启用 {name}', { name: label })}
                      onChange={(event) =>
                        setDraft((current) =>
                          current.map((value) =>
                            value.command === item.command
                              ? { ...value, enabled: event.target.checked }
                              : value,
                          ),
                        )
                      }
                    />
                    <span>{t('启用')}</span>
                  </label>
                  <Button
                    variant="ghost"
                    className="settings-shortcut-key"
                    aria-label={
                      capturing === item.command
                        ? t('正在录入快捷键')
                        : t('编辑 {name}', { name: label })
                    }
                    onClick={() => setCapturing(item.command)}
                  >
                    {capturing === item.command ? t('请按组合键…') : formatShortcut(binding.keys)}
                  </Button>
                  <Button
                    variant="ghost"
                    iconOnly
                    aria-label={t('清除 {name}', { name: label })}
                    onClick={() =>
                      setDraft((current) =>
                        current.map((value) =>
                          value.command === item.command ? { ...value, keys: '' } : value,
                        ),
                      )
                    }
                  >
                    <Trash2 size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    iconOnly
                    aria-label={t('恢复 {name}', { name: label })}
                    onClick={() => resetOne(item.command)}
                  >
                    <RotateCcw size={14} />
                  </Button>
                </div>
              </div>
            );
          })}
        </section>
      ))}
      {error ? (
        <p className="error-text" role="alert">
          {translateError(error)}
        </p>
      ) : null}
      <footer className="settings-actions settings-shortcut-footer">
        <span role="status">
          {!dirty && saved.length ? (
            <>
              <Check size={13} /> {t('已保存')}
            </>
          ) : (
            ''
          )}
        </span>
        <Button
          variant="primary"
          disabled={!dirty || conflicts.size > 0}
          onClick={() => void save()}
        >
          {t('保存快捷键')}
        </Button>
      </footer>
    </div>
  );
}
