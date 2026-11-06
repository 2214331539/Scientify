import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import {
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  FlaskConical,
  FolderPlus,
  Info,
  MessageSquare,
  NotebookPen,
  TriangleAlert,
  UserPlus,
  UsersRound,
} from 'lucide-react';
import { Button } from '../../components/primitives';
import { t } from '../../i18n';
import type { Project, Workspace } from '../../domain/workspace';
import type { WorkContext } from '../../domain/context';
import type { WorkspaceStore } from '../../stores/workspace';
import type { SearchTarget } from '../search/SearchDialog';
import {
  isSyncedProject,
  requestSignIn,
  type CollaborationProject,
} from '../../platform/collaboration';
import { maskPhone } from '../account/account';
import { classifyCloud, isNewCloudProject, markCloudSeen, useCloud } from './cloud';
import { CenterHeader, MiniCover, ProjectCoverArt, type CoverBadge } from './ProjectCover';
import {
  coverColor,
  isTeamProject,
  lastActive,
  personalProjects,
  readOpened,
  relativeTime,
  type CenterPage,
} from './model';

const dismissedKey = 'scientify.home.dismissed';
function readDismissed(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(dismissedKey) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

type Recent = {
  key: string;
  kind: 'note' | 'run' | 'chat';
  title: string;
  project: Project;
  detail: string;
  at: string;
  target: SearchTarget | { source: WorkContext };
};

const roleNames: Record<string, string> = {
  owner: '所有者',
  editor: '编辑者',
  reviewer: '审阅者',
  viewer: '查看者',
};

/** Recently edited notes, runs and AI conversations across projects, newest first. */
export function recentWork(data: Workspace, limit = 6): Recent[] {
  const projects = new Map(data.projects.filter((p) => !p.archived).map((p) => [p.id, p]));
  const items: Recent[] = [];
  for (const record of data.records) {
    const project = projects.get(record.project);
    if (!project || record.type !== 'note' || !record.updatedAt) continue;
    items.push({
      key: `note:${record.id}`,
      kind: 'note',
      title: record.title || t('未命名笔记'),
      project,
      detail: t('项目笔记'),
      at: record.updatedAt,
      target: {
        source: {
          projectId: project.id,
          workspace: 'notes',
          resourceId: record.id,
          title: record.title,
        },
      },
    });
  }
  for (const run of data.runs) {
    const project = projects.get(run.project);
    const at = typeof run.updatedAt === 'string' ? run.updatedAt : '';
    if (!project || !at) continue;
    const name = typeof run.name === 'string' && run.name ? run.name : t('运行记录');
    const status = typeof run.status === 'string' ? run.status : '';
    items.push({
      key: `run:${run.id}`,
      kind: 'run',
      title: name,
      project,
      detail:
        status === 'failed'
          ? t('运行失败')
          : status === 'completed'
            ? t('运行完成')
            : status === 'running'
              ? t('运行中')
              : t('运行记录'),
      at,
      target: {
        source: {
          projectId: project.id,
          workspace: 'experiments',
          resourceId: run.id,
          title: name,
        },
      },
    });
  }
  for (const session of data.sessions) {
    const project = projects.get(session.project);
    const at = typeof session.updatedAt === 'string' ? session.updatedAt : '';
    if (!project || !at) continue;
    const title = typeof session.title === 'string' && session.title ? session.title : t('AI 对话');
    items.push({
      key: `chat:${session.id}`,
      kind: 'chat',
      title,
      project,
      detail: t('AI 对话'),
      at,
      target: { projectId: project.id, workspace: 'overview', tool: 'assistant' },
    });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

type Pending = {
  key: string;
  tone: 'info' | 'warn' | 'bad';
  icon: React.ReactNode;
  title: string;
  detail: string;
  network?: boolean;
  actions: { label: string; primary?: boolean; run(): void }[];
};

export function ProjectHome({
  store,
  onOpen,
  onOpenTarget,
  onOpenRemote,
  onNew,
  onPage,
  onSettings,
}: {
  store: WorkspaceStore;
  onOpen(id: string): void;
  onOpenTarget(projectId: string, target: SearchTarget | { source: WorkContext }): void;
  onOpenRemote(project: CollaborationProject, team: boolean): Promise<void>;
  onNew(): void;
  onPage(page: CenterPage): void;
  onSettings(section: 'collaboration' | 'data'): void;
}) {
  const data = useStore(store, (s) => s.data)!;
  const directory = useStore(store, (s) => s.directory);
  const busy = useStore(store, (s) => s.busy);
  const cloud = useCloud();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [error, setError] = useState('');
  const opened = useMemo(readOpened, [data]);
  const signedIn = !!cloud.state?.authenticated;
  const { team, elsewhere } = classifyCloud(cloud, data.projects);
  const mine = personalProjects(data).filter((p) => !p.archived);
  const recentProjects = data.projects
    .filter((p) => !p.archived)
    .sort((a, b) => lastActive(b, opened).localeCompare(lastActive(a, opened)))
    .slice(0, 8);
  const recents = recentWork(data);
  function dismiss(key: string) {
    const next = [...dismissed, key];
    setDismissed(next);
    try {
      localStorage.setItem(dismissedKey, JSON.stringify(next.slice(-200)));
    } catch {
      /* Dismissal is a convenience. */
    }
  }
  async function download(remote: CollaborationProject) {
    setError('');
    try {
      markCloudSeen(remote.id);
      await onOpenRemote(remote, true);
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    }
  }
  const pending: Pending[] = [];
  for (const entry of team) {
    if (entry.local || entry.remote.role === 'owner' || !isNewCloudProject(entry.remote.id))
      continue;
    const owner = entry.members?.find((member) => member.role === 'owner');
    pending.push({
      key: `joined:${entry.remote.id}`,
      tone: 'info',
      icon: <UserPlus />,
      title: t('你已加入「{name}」', { name: entry.remote.name }),
      detail: [
        owner ? t('所有者 {phone}', { phone: maskPhone(owner.phone) }) : '',
        t(roleNames[entry.remote.role] ?? entry.remote.role),
      ]
        .filter(Boolean)
        .join(' · '),
      network: true,
      actions: [
        { label: t('下载并打开'), primary: true, run: () => void download(entry.remote) },
        { label: t('知道了'), run: () => markCloudSeen(entry.remote.id) },
      ],
    });
  }
  for (const project of data.projects.filter(isSyncedProject)) {
    const sync = cloud.sync[project.id];
    if (!sync) continue;
    if (sync.conflicts.length)
      pending.push({
        key: `conflict:${project.id}`,
        tone: 'warn',
        icon: <TriangleAlert />,
        title: t('「{name}」有 {count} 处同步冲突', {
          name: project.name,
          count: sync.conflicts.length,
        }),
        detail: t('本机版本已另存为冲突副本'),
        actions: [{ label: t('查看'), run: () => onSettings('collaboration') }],
      });
    else if (sync.lastError)
      pending.push({
        key: `sync-error:${project.id}`,
        tone: 'bad',
        icon: <CircleX />,
        title: t('「{name}」同步失败', { name: project.name }),
        detail: sync.lastError,
        network: true,
        actions: [{ label: t('查看'), run: () => onSettings('collaboration') }],
      });
  }
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  for (const run of data.runs) {
    const project = data.projects.find((p) => p.id === run.project && !p.archived);
    const at = typeof run.updatedAt === 'string' ? run.updatedAt : '';
    if (!project || run.status !== 'failed' || at < weekAgo || dismissed.includes(`run:${run.id}`))
      continue;
    const name = typeof run.name === 'string' && run.name ? run.name : t('运行记录');
    pending.push({
      key: `run:${run.id}`,
      tone: 'bad',
      icon: <CircleX />,
      title: t('运行失败：{name}', { name }),
      detail: `${project.name} · ${relativeTime(at)}`,
      actions: [
        {
          label: t('查看'),
          run: () =>
            onOpenTarget(project.id, {
              source: {
                projectId: project.id,
                workspace: 'experiments',
                resourceId: run.id,
                title: name,
              },
            }),
        },
        { label: t('知道了'), run: () => dismiss(`run:${run.id}`) },
      ],
    });
  }
  const offline = signedIn && !cloud.reachable;
  if (!data.projects.length && !elsewhere.length)
    return (
      <section className="center-page" aria-label={t('首页')}>
        <CenterHeader title={t('首页')} />
        <div className="center-scroll">
          <section className="home-section">
            <h2 className="home-heading">{t('开始使用')}</h2>
            <div className="home-start">
              <button type="button" className="home-tile" disabled={busy} onClick={onNew}>
                <span className="home-tile-icon tone-paper">
                  <FolderPlus />
                </span>
                <strong>{t('新建项目')}</strong>
              </button>
              <button
                type="button"
                className="home-tile"
                onClick={() => (signedIn ? onPage('team') : requestSignIn())}
              >
                <span className="home-tile-icon tone-run">
                  <UsersRound />
                </span>
                <strong>{signedIn ? t('查看团队项目') : t('登录并下载团队项目')}</strong>
              </button>
            </div>
            {directory ? (
              <p className="home-location">
                <Info />
                <span>
                  {t('项目数据保存在')} <code>{directory}</code>
                </span>
                <Button variant="ghost" size="sm" onClick={() => onSettings('data')}>
                  {t('更改')}
                </Button>
              </p>
            ) : null}
          </section>
        </div>
      </section>
    );
  return (
    <section className="center-page" aria-label={t('首页')}>
      <CenterHeader title={t('首页')}>
        <Button variant="primary" disabled={busy} onClick={onNew}>
          <FolderPlus />
          {t('新建项目')}
        </Button>
      </CenterHeader>
      <div className="center-scroll">
        {recentProjects.length ? (
          <section className="home-section">
            <div className="home-section-head">
              <h2 className="home-heading">{t('最近项目')}</h2>
              <div className="home-links">
                <Button variant="ghost" size="sm" onClick={() => onPage('mine')}>
                  {t('我的项目')} {mine.length}
                  <ChevronRight />
                </Button>
                {signedIn ? (
                  <Button variant="ghost" size="sm" onClick={() => onPage('team')}>
                    {t('团队项目')} {team.length}
                    <ChevronRight />
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="home-shelf">
              {recentProjects.map((project) => {
                const badges: CoverBadge[] = isTeamProject(project)
                  ? ['team']
                  : isSyncedProject(project)
                    ? [offline ? 'offline' : 'synced']
                    : [];
                return (
                  <div className="home-book" key={project.id}>
                    <button
                      type="button"
                      className="project-cover"
                      aria-label={project.name}
                      title={project.question || project.name}
                      disabled={busy}
                      onClick={() => onOpen(project.id)}
                    >
                      <ProjectCoverArt
                        name={project.name}
                        field={project.field}
                        color={coverColor(project)}
                        favorite={project.favorite}
                        badges={badges}
                      />
                    </button>
                    <span className="project-book-meta">
                      {relativeTime(lastActive(project, opened))}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
        <div className="home-columns">
          <section className="home-section" aria-label={t('继续工作')}>
            <h2 className="home-heading">{t('继续工作')}</h2>
            {recents.length ? (
              <ul className="home-recent">
                {recents.map((item) => (
                  <li key={item.key}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onOpenTarget(item.project.id, item.target)}
                    >
                      <span className={`home-recent-icon kind-${item.kind}`}>
                        {item.kind === 'note' ? (
                          <NotebookPen />
                        ) : item.kind === 'run' ? (
                          <FlaskConical />
                        ) : (
                          <MessageSquare />
                        )}
                      </span>
                      <span className="home-recent-text">
                        <strong>{item.title}</strong>
                        <small>
                          <MiniCover color={coverColor(item.project)} />
                          <span>{item.project.name}</span>
                          <span aria-hidden="true">·</span>
                          <span>{item.detail}</span>
                        </small>
                      </span>
                      <time dateTime={item.at}>{relativeTime(item.at)}</time>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="home-none">
                <Clock />
                {t('还没有最近的内容')}
              </p>
            )}
          </section>
          <section className="home-section" aria-label={t('待处理')}>
            <h2 className="home-heading">
              {t('待处理')}
              {pending.length ? <span className="center-count">{pending.length}</span> : null}
            </h2>
            {pending.length ? (
              <ul className="home-pending">
                {pending.map((item) => (
                  <li key={item.key} className={`tone-${item.tone}`}>
                    <span className="home-pending-icon">{item.icon}</span>
                    <div>
                      <strong>{item.title}</strong>
                      <small>{item.detail}</small>
                      <div className="home-pending-actions">
                        {item.network && offline ? (
                          <Button size="sm" disabled>
                            {t('联网后处理')}
                          </Button>
                        ) : (
                          item.actions.map((action) => (
                            <Button
                              key={action.label}
                              size="sm"
                              variant={action.primary ? 'primary' : 'secondary'}
                              disabled={busy}
                              onClick={action.run}
                            >
                              {action.label}
                            </Button>
                          ))
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="home-none">
                <CircleCheck />
                {t('没有需要处理的事项')}
              </p>
            )}
            {error ? (
              <p role="alert" className="error-text">
                {error}
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </section>
  );
}
