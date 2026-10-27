import { t } from '../i18n';
import { useStore } from 'zustand';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { Bot, Languages, NotebookPen, X } from 'lucide-react';
import { Button } from '../components/primitives';
import type { WorkContext } from '../domain/context';
import type { ResearchBackend } from '../platform/research';
import type { WorkspaceStore } from '../stores/workspace';
import { AssistantPanel } from '../features/assistant/AssistantPanel';
import { NotesPanel } from '../features/notes/NotesPanel';
import { NativeTranslationPanel } from '../features/translation/NativeTranslationPanel';
import { scopeFor } from '../features/notes/model';
import './auxiliary.css';
import { isTauri } from '@tauri-apps/api/core';
import {
  translationWindow,
  watchTranslationWindow,
  type TranslationHandoff,
} from '../features/translation/window';

export interface GlobalDockProps {
  store: WorkspaceStore;
  backend: ResearchBackend;
  tool: 'assistant' | 'notes' | 'translator';
  context: WorkContext;
  open?: boolean;
  notesWorkspace?: boolean;
  resizeHandle?: ReactNode;
  onNoteContext?: (context: WorkContext) => void;
  onToolChange: (tool: 'assistant' | 'notes' | 'translator') => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  workspaceContent?: ReactNode;
  notesLayerRef?: RefObject<HTMLElement | null>;
  notesWorkspaceActive?: boolean;
}

function AuxiliarySession({
  tool,
  scope,
  context,
  active,
  store,
  backend,
  markDirty,
  onNoteContext,
}: {
  tool: 'assistant' | 'notes';
  scope: string;
  context: WorkContext;
  active: boolean;
  store: WorkspaceStore;
  backend: ResearchBackend;
  markDirty: (source: string, dirty: boolean) => void;
  onNoteContext?: (context: WorkContext) => void;
}) {
  const dirty = useCallback(
    (value: boolean) => markDirty(`${tool}:${scope}`, value),
    [markDirty, scope, tool],
  );
  return (
    <div className="sf-dock-session" hidden={!active}>
      {tool === 'assistant' ? (
        <AssistantPanel
          store={store}
          backend={backend}
          scope={scope}
          context={context}
          onDirtyChange={dirty}
        />
      ) : (
        <NotesPanel
          store={store}
          scope={scope}
          context={context}
          onDirtyChange={dirty}
          onContext={active ? onNoteContext : undefined}
        />
      )}
    </div>
  );
}

/** One persistent note editor per project; changing its placement never duplicates or remounts drafts. */
export function GlobalDock({
  store,
  backend,
  tool,
  context,
  open = true,
  notesWorkspace = false,
  resizeHandle,
  onNoteContext,
  onToolChange,
  onClose,
  onDirtyChange,
  workspaceContent,
  notesLayerRef,
  notesWorkspaceActive = notesWorkspace,
}: GlobalDockProps) {
  const scope = scopeFor(context);
  const handoffTarget = useRef({ scope, onToolChange });
  handoffTarget.current = { scope, onToolChange };
  const deliveredHandoff = useRef<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const stop = watchTranslationWindow(
      'translation-assistant-handoff',
      async () => {
        const payload = await translationWindow<TranslationHandoff | null>({ type: 'takeHandoff' });
        if (disposed || !payload) return;
        if (deliveredHandoff.current !== payload.id) {
          const target = handoffTarget.current;
          window.dispatchEvent(
            new CustomEvent('scientify-assistant-prefill', {
              detail: { ...payload, scope: target.scope },
            }),
          );
          target.onToolChange('assistant');
          deliveredHandoff.current = payload.id;
        }
        await translationWindow({ type: 'ackHandoff', id: payload.id });
      },
      (reason) => store.setState({ error: String(reason) }),
    );
    return () => {
      disposed = true;
      stop();
    };
  }, [store]);
  const scopes = useRef(new Map<string, WorkContext>());
  const dirtySources = useRef(new Set<string>());
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  scopes.current.set(scope, context);
  const markDirty = useCallback((source: string, dirty: boolean) => {
    const before = dirtySources.current.size > 0;
    if (dirty) dirtySources.current.add(source);
    else dirtySources.current.delete(source);
    if (before !== dirtySources.current.size > 0)
      dirtyCallback.current?.(dirtySources.current.size > 0);
  }, []);
  const integrated = workspaceContent !== undefined;
  const translationEnabled = useStore(
    store,
    (state) => isTauri() || state.data?.settings.translation?.enabled !== false,
  );
  const sideVisible =
    open &&
    (!notesWorkspaceActive || tool !== 'notes') &&
    (tool !== 'translator' || translationEnabled);
  const notesVisible = notesWorkspaceActive || (open && tool === 'notes' && !notesWorkspace);
  const assistantVisible = open && tool === 'assistant';
  const translatorVisible = open && tool === 'translator' && translationEnabled;
  useLayoutEffect(() => {
    if (!notesWorkspace && notesLayerRef?.current) {
      notesLayerRef.current.hidden = !notesVisible;
      notesLayerRef.current.inert = !notesVisible;
      notesLayerRef.current.setAttribute('aria-hidden', String(!notesVisible));
    }
  }, [notesWorkspace, notesVisible, notesLayerRef]);
  const sessions = (current: 'assistant' | 'notes') =>
    [...scopes.current.entries()].map(([sessionScope, scopedContext]) => (
      <AuxiliarySession
        key={sessionScope}
        tool={current}
        scope={sessionScope}
        context={scopedContext}
        active={sessionScope === scope}
        store={store}
        backend={backend}
        markDirty={markDirty}
        onNoteContext={notesWorkspaceActive ? onNoteContext : undefined}
      />
    ));
  return (
    <div
      className={`sf-dock-layout${notesWorkspace ? ' has-notes-workspace' : ' auxiliary-surface'}${integrated ? ' sf-workspace-layout' : ''}`}
      data-side-open={sideVisible}
      data-tool={tool}
      hidden={!integrated && !notesWorkspace && !open}
      role={integrated || notesWorkspace ? undefined : 'complementary'}
      aria-label={integrated || notesWorkspace ? undefined : t('全局辅助工具')}
    >
      {integrated && <div className="sf-dock-main">{workspaceContent}</div>}
      <div className="sf-dock-resize" hidden={!sideVisible}>
        {resizeHandle}
      </div>
      <div className="sf-dock-header sf-dock-shared-header" hidden={!sideVisible}>
        <div className="sf-dock-tabs" role="group" aria-label={t('辅助工具切换')}>
          <span className="sf-dock-tab-indicator" aria-hidden="true" />
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={tool === 'assistant'}
            onClick={() => onToolChange('assistant')}
          >
            <Bot size={14} />
            {t('AI Assistant')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={tool === 'notes'}
            onClick={() => onToolChange('notes')}
          >
            <NotebookPen size={14} />
            {t('Notes')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={tool === 'translator'}
            disabled={!translationEnabled}
            onClick={() => onToolChange('translator')}
          >
            <Languages size={14} />
            {t('翻译')}
          </Button>
        </div>
        <Button variant="ghost" size="sm" iconOnly aria-label={t('收起辅助栏')} onClick={onClose}>
          <X size={15} />
        </Button>
      </div>
      <div
        ref={notesLayerRef as RefObject<HTMLDivElement | null> | undefined}
        className={`sf-dock-layer sf-dock-notes sf-global-dock${notesWorkspace ? ' notes-workspace-surface' : ''}`}
        data-active={notesVisible}
        aria-hidden={!notesVisible}
        inert={!notesVisible}
        role={notesWorkspaceActive ? 'main' : integrated ? 'complementary' : undefined}
        aria-label={
          notesWorkspaceActive ? t('Notes workspace') : integrated ? t('全局辅助工具') : t('Notes')
        }
      >
        <div className="sf-dock-header sf-notes-workspace-header" hidden={!notesWorkspace}>
          <span className="workspace-name">{t('Notes')}</span>
        </div>
        {sessions('notes')}
      </div>
      <aside
        className="sf-dock-layer sf-dock-assistant sf-global-dock"
        data-active={assistantVisible}
        aria-hidden={!assistantVisible}
        inert={!assistantVisible}
        aria-label={t('AI Assistant')}
      >
        {sessions('assistant')}
      </aside>
      <aside
        className="sf-dock-layer sf-dock-translator sf-global-dock"
        data-active={translatorVisible}
        aria-hidden={!translatorVisible}
        inert={!translatorVisible}
        aria-label={t('翻译')}
      >
        {isTauri() ? (
          <NativeTranslationPanel context={context} />
        ) : (
          <p>{t('划词翻译请在 Scientify 桌面应用中使用。')}</p>
        )}
      </aside>
    </div>
  );
}
