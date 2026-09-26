import { t, translateError, locale } from '../../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { ArrowLeft, BookOpen, Check, Link2, Plus, Save, Search } from 'lucide-react';
import { Button, Input, Textarea } from '../../components/primitives';
import { ResourceList, ResourceRow } from '../../components/workspace/ResourceList';
import { Panel } from '../../components/layout/Panel';
import type { WorkContext } from '../../domain/context';
import type { WorkspaceStore } from '../../stores/workspace';
import {
  captureSource,
  createNote,
  noteFingerprint,
  persistNote,
  readNoteSources,
  selectNotes,
  type Note,
} from './model';
import { Markdown } from './Markdown';

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
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const [error, setError] = useState('');
  const latest = useRef<Note | null>(null);
  const baseline = useRef('');
  const inFlight = useRef<Promise<boolean> | null>(null);
  const openNote = useRef<(id: string) => void>(() => {});
  const sourceKey = `notes:${scope}`;
  const notes = selectNotes(data, scope, query);
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

  function edit(value: Note) {
    latest.current = value;
    setDraft(value);
    setError('');
    const dirty = noteFingerprint(value) !== baseline.current;
    setStatus(dirty ? 'dirty' : 'saved');
    markDirty(dirty);
  }

  async function switchNote(note: Note | null, isNew = false) {
    if (!(await save())) return;
    // A save acknowledgment must never hide input entered while saving.
    if (latest.current && noteFingerprint(latest.current) !== baseline.current) return;
    const next = note ? structuredClone(note) : null;
    latest.current = next;
    baseline.current = isNew || !next ? '' : noteFingerprint(next);
    setDraft(next);
    setPreview(false);
    setError('');
    setStatus(isNew ? 'dirty' : 'saved');
    markDirty(isNew);
  }

  openNote.current = (id: string) => {
    const note = store
      .getState()
      .data?.records.find((item) => item.project === scope && item.id === id);
    if (note && latest.current?.id !== note.id) void switchNote(note as Note);
  };

  function addSource() {
    if (!draft || (!context.resourceId && !context.path && !context.selection && !context.text))
      return;
    const source = captureSource(context);
    edit({ ...draft, sources: [...(Array.isArray(draft.sources) ? draft.sources : []), source] });
  }

  return (
    <Panel className="sf-notes-panel" role="region" aria-label={t('研究笔记内容')}>
      <div className="sf-aux-toolbar">
        {draft ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            title={t('返回笔记列表')}
            aria-label={t('返回笔记列表')}
            onClick={() => void switchNote(null)}
          >
            <ArrowLeft size={16} />
          </Button>
        ) : (
          <span className="sf-muted">
            {scope === '__inbox__' ? t('个人收集箱') : t('项目笔记')}
          </span>
        )}
        <span className="sf-spacer" />
        <Button variant="ghost" size="sm" onClick={() => void switchNote(createNote(scope), true)}>
          <Plus size={14} />
          {t('新建笔记')}
        </Button>
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
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                title={preview ? t('编辑笔记') : t('预览 Markdown')}
                aria-label={preview ? t('编辑笔记') : t('预览 Markdown')}
                aria-pressed={preview}
                onClick={() => setPreview(!preview)}
              >
                <BookOpen size={14} />
              </Button>
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
          {preview ? (
            <div className="sf-note-preview sf-aux-scroll">
              <Markdown>{draft.body || t('还没有正文。')}</Markdown>
            </div>
          ) : (
            <Textarea
              className="sf-note-editor"
              aria-label={t('笔记正文')}
              spellCheck={false}
              placeholder={t('Write a note…')}
              value={draft.body}
              onChange={(event) => edit({ ...draft, body: event.target.value })}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                  event.preventDefault();
                  void save();
                }
              }}
            />
          )}
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
      ) : (
        <>
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
