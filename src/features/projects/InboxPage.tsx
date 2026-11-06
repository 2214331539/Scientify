import { useStore } from 'zustand';
import { Bot, MessageSquare, NotebookPen, Plus } from 'lucide-react';
import { Button } from '../../components/primitives';
import { t } from '../../i18n';
import type { WorkspaceStore } from '../../stores/workspace';
import { PERSONAL_SCOPE } from '../notes/model';
import { CenterEmpty, CenterHeader } from './ProjectCover';
import { relativeTime } from './model';

const excerpt = (body: string) =>
  body
    .split('\n')
    .map((line) => line.replace(/^[#>*\-\s\d.]+/, '').trim())
    .find(Boolean) ?? '';

/** Notes and quick questions that do not belong to a project yet; editing happens in the side panel. */
export function InboxPage({
  store,
  onOpenNote,
  onNewNote,
  onAsk,
}: {
  store: WorkspaceStore;
  onOpenNote(id: string): void;
  onNewNote(): void;
  onAsk(): void;
}) {
  const data = useStore(store, (s) => s.data)!;
  const notes = data.records
    .filter((record) => record.project === PERSONAL_SCOPE && record.type === 'note')
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  const chats = data.sessions
    .filter((session) => session.project === PERSONAL_SCOPE)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return (
    <section className="center-page" aria-label={t('收集箱')}>
      <CenterHeader title={t('收集箱')} count={notes.length}>
        <Button onClick={onAsk}>
          <Bot />
          {t('快速问答')}
        </Button>
        <Button variant="primary" onClick={onNewNote}>
          <Plus />
          {t('新建笔记')}
        </Button>
      </CenterHeader>
      <div className="center-scroll">
        <div className="inbox-columns">
          <section aria-label={t('随手笔记')}>
            <h2 className="home-heading">
              {t('随手笔记')}
              {notes.length ? <span className="center-count">{notes.length}</span> : null}
            </h2>
            {notes.length ? (
              <ul className="inbox-list">
                {notes.map((note) => (
                  <li key={note.id}>
                    <button type="button" onClick={() => onOpenNote(note.id)}>
                      <NotebookPen />
                      <span>
                        <strong>{note.title || t('未命名笔记')}</strong>
                        <small>{excerpt(note.body) || t('空白笔记')}</small>
                      </span>
                      <time dateTime={note.updatedAt}>{relativeTime(note.updatedAt)}</time>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <CenterEmpty
                icon={<NotebookPen />}
                title={t('收集箱是空的')}
                actions={
                  <Button variant="primary" onClick={onNewNote}>
                    <Plus />
                    {t('新建笔记')}
                  </Button>
                }
              />
            )}
          </section>
          <section aria-label={t('快速问答')}>
            <h2 className="home-heading">
              {t('快速问答')}
              {chats.length ? <span className="center-count">{chats.length}</span> : null}
            </h2>
            {chats.length ? (
              <ul className="inbox-list">
                {chats.map((chat) => (
                  <li key={chat.id}>
                    <button type="button" onClick={onAsk}>
                      <MessageSquare />
                      <span>
                        <strong>
                          {typeof chat.title === 'string' && chat.title ? chat.title : t('AI 对话')}
                        </strong>
                      </span>
                      <time>
                        {relativeTime(typeof chat.updatedAt === 'string' ? chat.updatedAt : '')}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="home-none">
                <MessageSquare />
                {t('还没有问答')}
              </p>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
