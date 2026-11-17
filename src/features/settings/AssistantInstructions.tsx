import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { Button, Textarea } from '../../components/primitives';
import { t } from '../../i18n';
import type { WorkspaceStore } from '../../stores/workspace';

const LIMIT = 4000;

/**
 * Settings → AI: what the assistant should know about you and how it should
 * answer, in every chat (ChatGPT's custom instructions). Projects add their own
 * in project settings.
 */
export function AssistantInstructions({ store }: { store: WorkspaceStore }) {
  const saved = useStore(store, (state) => {
    const value = state.data?.settings.assistantInstructions;
    return typeof value === 'string' ? value : '';
  });
  const busy = useStore(store, (state) => state.busy);
  const [draft, setDraft] = useState(saved);
  const [done, setDone] = useState(false);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = draft !== saved;
  useEffect(() => {
    store.getState().setDirtySource('settings-instructions', dirty);
    return () => store.getState().setDirtySource('settings-instructions', false);
  }, [dirty, store]);
  async function save() {
    const ok = await store.getState().update((workspace) => {
      workspace.settings.assistantInstructions = draft.trim();
    });
    if (ok) setDone(true);
  }
  return (
    <div className="settings-instructions">
      <h3>{t('自定义指令')}</h3>
      <p className="muted">
        {t(
          '希望 AI 了解你什么、怎样回答。例如研究方向、常用语言和工具、回答的详略。对新对话生效。',
        )}
      </p>
      <Textarea
        rows={5}
        maxLength={LIMIT}
        value={draft}
        disabled={busy}
        placeholder={t('例如：我做视频理解方向，代码用 PyTorch；回答先给结论，引用给出论文链接。')}
        onChange={(event) => {
          setDraft(event.target.value);
          setDone(false);
        }}
      />
      <div className="settings-actions">
        <span className="muted">{done && !dirty ? t('已保存') : `${draft.length} / ${LIMIT}`}</span>
        <Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
          {t('保存')}
        </Button>
      </div>
    </div>
  );
}
