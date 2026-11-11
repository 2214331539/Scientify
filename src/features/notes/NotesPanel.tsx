import { t, translateError, locale } from '../../i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { noteImages } from '../../platform/note-images';
import { openBrowserSource } from '../../platform/browser-pane';
import { useStore } from 'zustand';
import { ArrowLeft, Check, Link2, Plus, RotateCcw, Save, Search, Trash2 } from 'lucide-react';
import { Button, Input } from '../../components/primitives';
import { confirmAction } from '../../components/prompts';
import { ResourceList, ResourceRow } from '../../components/workspace/ResourceList';
import { Panel } from '../../components/layout/Panel';
import type { WorkContext } from '../../domain/context';
import type { WorkspaceStore } from '../../stores/workspace';
import {
  captureSource,
  createNote,
  isTrashed,
  noteFingerprint,
  persistNote,
  purgeNote,
  readNoteSources,
  restoreNote,
  selectNotes,
  selectTrash,
  trashNote,
  TRASH_DAYS,
  type Note,
} from './model';
import { MarkdownLiveEditor } from './MarkdownLiveEditor';

export interface NotesPanelProps {
  store: WorkspaceStore;
  scope: string;
  context: WorkContext;
  onDirtyChange?: (dirty: boolean) => void;
  onContext?: (context: WorkContext) => void;
}

export function NotesPanel({ store, scope, context, onDirtyChange, onContext }: NotesPanelProps) {
  const data = useStore(store, (state) => state.data);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Note | null>(null);
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const [error, setError] = useState('');
  const latest = useRef<Note | null>(null);
  const baseline = useRef('');
  const inFlight = useRef<Promise<boolean> | null>(null);
  const openNote = useRef<(id: string) => void>(() => {});
  const newNote = useRef<() => void>(() => {});
  const sourceKey = `notes:${scope}`;
  const images = useMemo(() => noteImages(scope), [scope]);
  const imagePending = useRef(false);
  const notes = selectNotes(data, scope, query);
  const trash = selectTrash(data, scope);
  const [trashOpen, setTrashOpen] = useState(false);
  const [removed, setRemoved] = useState<{ id: string; title: string } | null>(null);
  // Viewers of a team project cannot change it; the server would reject the change.
  const readOnly =
    (data?.projects.find((project) => project.id === scope) as { collaborationRole?: string })
      ?.collaborationRole === 'viewer';
  const sources = readNoteSources(draft);

  useEffect(() => {
    onContext?.({
      projectId: scope === '__inbox__' ? undefined : scope,
      workspace: 'notes',
      title: draft?.title || t('Notes'),
      resourceId: draft?.id,
      text: draft?.body,
    });
  }, [onContext, scope, draft?.id, draft?.title, draft?.body]);

  const markDirty = useCallback(
    (dirty: boolean) => {
      store.getState().setDirtySource(sourceKey, dirty);
      onDirtyChange?.(dirty);
    },
    [store, sourceKey, onDirtyChange],
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) {
      const success = await inFlight.current;
      if (!success) return false;
    }
    const current = latest.current;
    if (!current || noteFingerprint(current) === baseline.current) return true;
    const fingerprint = noteFingerprint(current);
    setStatus('saving');
    setError('');
    const operation = persistNote(store, current);
    inFlight.current = operation;
    const success = await operation;
    inFlight.current = null;
    if (success) {
      baseline.current = fingerprint;
      const dirty = !!latest.current && noteFingerprint(latest.current) !== fingerprint;
      setStatus(dirty ? 'dirty' : 'saved');
      markDirty(dirty);
    } else {
      setStatus('error');
      setError(store.getState().error || t('笔记尚未写入本机，请重试保存。'));
      markDirty(true);
    }
    return success;
  }, [store, markDirty]);

  useEffect(() => {
    if (!draft || status !== 'dirty') return;
    const timer = window.setTimeout(() => {
      void save();
    }, 900);
    return () => window.clearTimeout(timer);
  }, [draft, status, save]);

  useEffect(
    () => () => {
      store.getState().setDirtySource(sourceKey, false);
    },
    [store, sourceKey],
  );
  useEffect(() => {
    function handle(event: Event) {
      const detail = (event as CustomEvent<{ scope?: string; id?: string }>).detail;
      if (detail?.scope === scope && typeof detail.id === 'string') openNote.current(detail.id);
    }
    window.addEventListener('scientify-open-note', handle);
    return () => window.removeEventListener('scientify-open-note', handle);
  }, [scope]);
  // The project center's inbox page asks the panel that owns the drafts to start a note.
  useEffect(() => {
    function handle(event: Event) {
      if ((event as CustomEvent<{ scope?: string }>).detail?.scope === scope) newNote.current();
    }
    window.addEventListener('scientify-new-note', handle);
    return () => window.removeEventListener('scientify-new-note', handle);
  }, [scope]);

  function edit(value: Note) {
    latest.current = value;
    setDraft(value);
    setError('');
    const dirty = noteFingerprint(value) !== baseline.current;
    setStatus(dirty ? 'dirty' : 'saved');
    markDirty(dirty);
  }

  async function switchNote(note: Note | null, isNew = false) {
    if (imagePending.current) return;
    if (!(await save())) return;
    // A save acknowledgment must never hide input entered while saving.
    if (latest.current && noteFingerprint(latest.current) !== baseline.current) return;
    const next = note ? structuredClone(note) : null;
    latest.current = next;
    baseline.current = isNew || !next ? '' : noteFingerprint(next);
    setDraft(next);
    setError('');
    setStatus(isNew ? 'dirty' : 'saved');
    markDirty(isNew);
    if (next) setTrashOpen(false);
  }

  newNote.current = () => void switchNote(createNote(scope), true);
  openNote.current = (id: string) => {
    const note = store
      .getState()
      .data?.records.find((item) => item.project === scope && item.id === id);
    if (note && !isTrashed(note) && latest.current?.id !== note.id) void switchNote(note as Note);
  };

  /** Move the open note to the recycle bin; its last edits are saved first. */
  async function trashCurrent() {
    const current = latest.current;
    if (!current || imagePending.current || readOnly) return;
    if (!(await save())) return;
    const stored = store
      .getState()
      .data?.records.some((record) => record.project === scope && record.id === current.id);
    // Close the editor before writing, so autosave cannot bring the note back.
    latest.current = null;
    baseline.current = '';
    setDraft(null);
    setStatus('saved');
    setError('');
    markDirty(false);
    if (!stored) return;
    if (await trashNote(store, scope, current.id))
      setRemoved({ id: current.id, title: current.title || t('未命名笔记') });
    else setError(store.getState().error || t('删除失败，请重试。'));
  }

  async function purge(note: Note) {
    if (
      !(await confirmAction(
        t('彻底删除“{title}”？无法恢复。', { title: note.title || t('未命名笔记') }),
      ))
    )
      return;
    if (!(await purgeNote(store, scope, note.id)))
      setError(store.getState().error || t('删除失败，请重试。'));
  }

  function addSource() {
    if (!draft || (!context.resourceId && !context.path && !context.selection && !context.text))
      return;
    const source = captureSource(context);
    edit({ ...draft, sources: [...(Array.isArray(draft.sources) ? draft.sources : []), source] });
  }

  return (
    <Panel className="sf-notes-panel" role="region" aria-label={t('研究笔记内容')}>
      <div className="sf-aux-toolbar">
        {draft || trashOpen ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            title={t('返回笔记列表')}
            aria-label={t('返回笔记列表')}
            onClick={() => (draft ? void switchNote(null) : setTrashOpen(false))}
          >
            <ArrowLeft size={16} />
          </Button>
        ) : (
          <span className="sf-muted">
            {scope === '__inbox__' ? t('个人收集箱') : t('项目笔记')}
          </span>
        )}
        {trashOpen && !draft ? <span className="sf-muted">{t('回收站')}</span> : null}
        <span className="sf-spacer" />
        {!draft && !trashOpen && trash.length ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            title={t('回收站')}
            aria-label={t('回收站')}
            onClick={() => {
              setRemoved(null);
              setTrashOpen(true);
            }}
          >
            <Trash2 size={14} />
          </Button>
        ) : null}
        {trashOpen && !draft ? null : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setRemoved(null);
              void switchNote(createNote(scope), true);
            }}
          >
            <Plus size={14} />
            {t('新建笔记')}
          </Button>
        )}
      </div>
      {draft ? (
        <>
          <div className="sf-note-heading">
            <Input
              aria-label={t('笔记标题')}
              value={draft.title}
              onChange={(event) => edit({ ...draft, title: event.target.value })}
            />
            <div className="sf-note-subline">
              <span role="status" className={status === 'error' ? 'sf-error-text' : 'sf-muted'}>
                {status === 'saving'
                  ? t('正在保存…')
                  : status === 'saved'
                    ? t('已保存到本机')
                    : status === 'error'
                      ? t('保存失败，草稿保留')
                      : t('未保存')}
              </span>
              <span className="sf-spacer" />
              {readOnly ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  title={t('删除笔记')}
                  aria-label={t('删除笔记')}
                  disabled={status === 'saving'}
                  onClick={() => void trashCurrent()}
                >
                  <Trash2 size={14} />
                </Button>
              )}
            </div>
          </div>
          {error ? (
            <div className="sf-aux-error" role="alert">
              {translateError(error)}
              <Button variant="ghost" size="sm" onClick={() => void save()}>
                {t('重试保存')}
              </Button>
            </div>
          ) : null}
          <div className="sf-note-workbench">
            <MarkdownLiveEditor
              key={draft.id}
              images={images}
              onLink={(url) => openBrowserSource(scope, url)}
              onPendingChange={(pending) => {
                imagePending.current = pending;
                store.getState().setDirtySource(`${sourceKey}:images`, pending);
              }}
              className="sf-note-editor"
              ariaLabel={t('笔记正文')}
              value={draft.body}
              onChange={(value) => edit({ ...draft, body: value })}
              onSave={() => void save()}
              shortcuts={data?.settings.shortcuts}
            />
          </div>
          {sources.length ? (
            <details className="sf-note-sources">
              <summary>{t('来源 · {count}', { count: sources.length })}</summary>
              {sources.map((source) => {
                const available =
                  !!(source.resourceId || source.path) &&
                  !!(
                    source.projectId &&
                    data?.projects.some((project) => project.id === source.projectId)
                  );
                return (
                  <div key={source.id}>
                    <Button
                      variant="ghost"
                      size="sm"

                      disabled={!available}
                      title={
                        available ? source.path || source.title : t('来源暂不可定位，摘录仍保留')
                      }
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent('scientify-open-source', { detail: { ...source } }),
                        )
                      }
                    >
                      <Link2 size={12} />
                      {source.title}
                      {source.page ? t(' · 第 {page} 页', { page: source.page }) : ''}
                    </Button>
                    {source.selection ? <blockquote>{source.selection}</blockquote> : null}
                  </div>
                );
              })}
            </details>
          ) : null}
          <div className="sf-aux-toolbar sf-note-footer">
            <Button
              variant="ghost"
              size="sm"

              disabled={
                (!context.resourceId && !context.path && !context.selection && !context.text) ||
                (context.workspace === 'notes' && context.resourceId === draft.id)
              }
              onClick={addSource}
              title={t('添加来源：{title}', { title: context.title })}
            >
              <Link2 size={14} />
              {t('添加当前来源')}
            </Button>
            <span className="sf-spacer" />
            <Button
              variant="ghost"
              size="sm"

              disabled={status === 'saving' || status === 'saved'}
              onClick={() => void save()}
            >
              {status === 'saved' ? <Check size={14} /> : <Save size={14} />}
              {t('保存')}
            </Button>
          </div>
        </>
      ) : trashOpen ? (
        <>
          {error ? (
            <div className="sf-aux-error" role="alert">
              {translateError(error)}
            </div>
          ) : null}
          <p className="sf-note-trash-hint">
            {t('删除 {days} 天后自动清除。', { days: TRASH_DAYS })}
          </p>
          <ResourceList
            className="sf-note-list sf-aux-scroll"
            label={t('回收站')}
            empty={t('回收站是空的')}
          >
            {trash.map((note) => (
              <li key={note.id} className="sf-resource-item sf-note-trash-row">
                <span>
                  <strong>{note.title || t('未命名笔记')}</strong>
                  <time dateTime={note.deletedAt}>
                    {t('删除于 {date}', {
                      date: new Date(note.deletedAt ?? '').toLocaleDateString(locale()),
                    })}
                  </time>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  title={t('恢复')}
                  aria-label={t('恢复“{title}”', { title: note.title || t('未命名笔记') })}
                  disabled={readOnly}
                  onClick={() => void restoreNote(store, scope, note.id)}
                >
                  <RotateCcw size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  title={t('彻底删除')}
                  aria-label={t('彻底删除“{title}”', { title: note.title || t('未命名笔记') })}
                  disabled={readOnly}
                  onClick={() => void purge(note)}
                >
                  <Trash2 size={14} />
                </Button>
              </li>
            ))}
          </ResourceList>
        </>
      ) : (
        <>
          {removed ? (
            <div className="sf-note-removed" role="status">
              <span>{t('已移到回收站')}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void restoreNote(store, scope, removed.id);
                  setRemoved(null);
                }}
              >
                {t('撤销')}
              </Button>
            </div>
          ) : null}
          {error ? (
            <div className="sf-aux-error" role="alert">
              {translateError(error)}
            </div>
          ) : null}
          <label className="sf-aux-search">
            <Search size={14} />
            <Input
              aria-label={t('搜索笔记')}
              placeholder={t('搜索笔记')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <ResourceList
            className="sf-note-list sf-aux-scroll"
            label={t('研究笔记')}
            empty={query ? t('没有匹配的笔记') : t('暂无笔记')}
          >
            {notes.map((note) => (
              <ResourceRow
                key={note.id}
                className="sf-note-row"
                onClick={() => void switchNote(note)}
              >
                <span>
                  <strong>{note.title || t('未命名笔记')}</strong>
                  <small>{note.body.slice(0, 100).replace(/\n/g, ' ') || t('空白笔记')}</small>
                  <time dateTime={note.updatedAt}>
                    {new Date(note.updatedAt).toLocaleDateString(locale())}
                  </time>
                </span>
              </ResourceRow>
            ))}
          </ResourceList>
        </>
      )}
    </Panel>
  );
}
