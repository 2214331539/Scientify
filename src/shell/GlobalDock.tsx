import { t } from '../i18n';
import { useCallback, useRef, type ReactNode } from 'react';
import { Bot, NotebookPen, X } from 'lucide-react';
import { Button } from '../components/primitives';
import type { WorkContext } from '../domain/context';
import type { ResearchBackend } from '../platform/research';
import type { WorkspaceStore } from '../stores/workspace';
import { AssistantPanel } from '../features/assistant/AssistantPanel';
import { NotesPanel } from '../features/notes/NotesPanel';
import { scopeFor } from '../features/notes/model';
import './auxiliary.css';

export interface GlobalDockProps {
  store: WorkspaceStore;
  backend: ResearchBackend;
  tool: 'assistant' | 'notes';
  context: WorkContext;
  open?: boolean;
  notesWorkspace?: boolean;
  resizeHandle?: ReactNode;
  onNoteContext?: (context: WorkContext) => void;
  onToolChange: (tool: 'assistant' | 'notes') => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
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
}: GlobalDockProps) {
  const scope = scopeFor(context);
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
  const header = (current: 'assistant' | 'notes', central = false) => (
    <div className="sf-dock-header">
      {central ? (
        <span className="workspace-name">{t('Notes')}</span>
      ) : (
        <div className="sf-dock-tabs" role="group" aria-label={t('辅助工具切换')}>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={current === 'assistant'}
            onClick={() => onToolChange('assistant')}
          >
            <Bot size={14} />
            {t('AI Assistant')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={current === 'notes'}
            onClick={() => onToolChange('notes')}
          >
            <NotebookPen size={14} />
            {t('Notes')}
          </Button>
        </div>
      )}
      {!central && (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t('收起辅助栏')}
          title={t('收起辅助栏')}
          onClick={onClose}
        >
          <X size={15} />
        </Button>
      )}
    </div>
  );
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
        onNoteContext={notesWorkspace ? onNoteContext : undefined}
      />
    ));
  return (
    <>
      <div
        className={notesWorkspace ? 'notes-workspace-surface' : 'auxiliary-surface'}
        hidden={!notesWorkspace && !(open && tool === 'notes')}
      >
        {!notesWorkspace && resizeHandle}
        <aside
          className="sf-global-dock"
          role={notesWorkspace ? 'main' : undefined}
          aria-label={notesWorkspace ? t('Notes workspace') : t('全局辅助工具')}
        >
          {header('notes', notesWorkspace)}
          {sessions('notes')}
        </aside>
      </div>
      <div className="auxiliary-surface" hidden={!(open && tool === 'assistant')}>
        {resizeHandle}
        <aside className="sf-global-dock" aria-label={t('全局辅助工具')}>
          {header('assistant')}
          {sessions('assistant')}
        </aside>
      </div>
    </>
  );
}
