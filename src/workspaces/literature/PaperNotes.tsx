import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link2, Save } from 'lucide-react';
import { Button } from '../../components/primitives';
import { confirmAction, requestText } from '../../components/prompts';
import { MarkdownLiveEditor } from '../../features/notes/MarkdownLiveEditor';
import { paperNote } from './local-session';
import type { LibraryBackend, LibraryPaper } from '../../platform/library';
import type { WorkContext } from '../../domain/context';
import { t, translateError } from '../../i18n';

export function PaperNotes({
  library,
  project,
  id,
  paper,
  selection,
  onPage,
}: {
  library: LibraryBackend;
  project: string;
  id: string;
  paper?: LibraryPaper;
  selection?: WorkContext;
  onPage: (page: number) => void;
}) {
  const session = paperNote(library, project, id);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [error, setError] = useState('');
  useEffect(() => {
    if (session.getSnapshot().phase === 'ready' && !session.getSnapshot().dirty)
      void session.reloadDiscardingEdits();
    else void session.load();
  }, [session]);
  return (
    <div className="paper-note-editor">
      <div className="paper-note-toolbar">
        <span className="truncate" title={paper?.path}>
          {paper?.path ?? t('原论文已移除')}
        </span>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('保存')}
          disabled={!state.dirty || state.phase === 'saving'}
          onClick={() => void session.save()}
        >
          <Save />
        </Button>
      </div>
      {(state.error || error) && (
        <div role="alert" className="inline-error">
          {translateError(state.error || error)}
          <Button onClick={() => void session.save()}>{t('重试保存')}</Button>
          <Button
            onClick={async () => {
              if (!state.dirty || (await confirmAction(t('重新读取会丢弃当前未保存编辑。'))))
                void session.reloadDiscardingEdits();
            }}
          >
            {t('重新读取文件')}
          </Button>
          <Button
            onClick={async () => {
              const path = await requestText(
                t('副本路径'),
                paper?.notePath.replace(/\.md$/i, '.copy.md') ?? 'note-copy.md',
              );
              if (!path) return;
              try {
                await library.saveNote(project, id, state.content, null, path);
                setError('');
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            {t('另存副本')}
          </Button>
        </div>
      )}
      {(state.phase === 'loading' && state.version === null) || state.phase === 'idle' ? (
        <div className="empty-state">{t('正在读取…')}</div>
      ) : (
        <div className="paper-note-workbench">
          <MarkdownLiveEditor
            ariaLabel={t('论文笔记正文')}
            value={state.content}
            disabled={state.phase === 'error'}
            onChange={(value) => session.edit(value)}
            onSave={() => void session.save()}
            onPage={onPage}
          />
        </div>
      )}
      <div className="paper-note-footer">
        <span>
          {state.phase === 'saving' ? t('正在保存…') : state.dirty ? t('未保存') : t('已保存')}
        </span>
        <span className="spacer" />
        <Button
          variant="ghost"
          disabled={!selection?.selection || selection.resourceId !== id}
          onClick={() =>
            session.edit(
              `${state.content}${state.content ? '\n\n' : ''}> ${selection?.selection?.replaceAll('\n', '\n> ')}\n\n[${t('页码')} ${selection?.page ?? 1}](scientify-page:${selection?.page ?? 1})\n`,
            )
          }
        >
          <Link2 />
          {t('摘录选文')}
        </Button>
      </div>
    </div>
  );
}
