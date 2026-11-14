import { useState } from 'react';
import { useStore } from 'zustand';
import { Bell, CircleX, FlaskConical, TriangleAlert, UserPlus } from 'lucide-react';
import { Button } from '../components/primitives';
import { Popover } from '../components/primitives/Popover';
import { t } from '../i18n';
import type { WorkContext } from '../domain/context';
import type { WorkspaceStore } from '../stores/workspace';
import { isSyncedProject, type CollaborationProject } from '../platform/collaboration';
import { maskPhone } from '../features/account/account';
import {
  classifyCloud,
  isNewCloudProject,
  markCloudSeen,
  useCloud,
} from '../features/projects/cloud';
import { relativeTime } from '../features/projects/model';
import './notifications.css';

const dismissedKey = 'scientify.home.dismissed';
function readDismissed(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(dismissedKey) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const roleNames: Record<string, string> = {
  owner: '所有者',
  editor: '编辑者',
  reviewer: '审阅者',
  viewer: '查看者',
};

type Item = {
  key: string;
  tone: 'info' | 'warn' | 'bad';
  icon: React.ReactNode;
  title: string;
  detail: string;
  network?: boolean;
  actions: { label: string; primary?: boolean; run(): void }[];
};

/** Things that need the user: new team projects, sync trouble and failed runs this week. */
export function Notifications({
  store,
  onOpenRemote,
  onOpenSource,
  onSyncSettings,
}: {
  store: WorkspaceStore;
  onOpenRemote(project: CollaborationProject, team: boolean): Promise<void>;
  onOpenSource(source: WorkContext): void;
  onSyncSettings(): void;
}) {
  const data = useStore(store, (s) => s.data);
  const busy = useStore(store, (s) => s.busy);
  const cloud = useCloud();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [error, setError] = useState('');
  if (!data) return null;
  const close = () => setAnchor(null);
  function dismiss(key: string) {
    const next = [...dismissed, key];
    setDismissed(next);
    try {
      localStorage.setItem(dismissedKey, JSON.stringify(next.slice(-200)));
    } catch {
      /* Dismissal is a convenience. */
    }
  }
  const items: Item[] = [];
  for (const entry of classifyCloud(cloud, data.projects).team) {
    if (entry.local || entry.remote.role === 'owner' || !isNewCloudProject(entry.remote.id))
      continue;
    const owner = entry.members?.find((member) => member.role === 'owner');
    items.push({
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
        {
          label: t('下载并打开'),
          primary: true,
          run: () => {
            setError('');
            markCloudSeen(entry.remote.id);
            void onOpenRemote(entry.remote, true)
              .then(close)
              .catch((reason) =>
                setError(String(reason instanceof Error ? reason.message : reason)),
              );
          },
        },
        { label: t('知道了'), run: () => markCloudSeen(entry.remote.id) },
      ],
    });
  }
  for (const project of data.projects.filter(isSyncedProject)) {
    const sync = cloud.sync[project.id];
    if (!sync) continue;
    if (sync.conflicts.length)
      items.push({
        key: `conflict:${project.id}`,
        tone: 'warn',
        icon: <TriangleAlert />,
        title: t('「{name}」有 {count} 处同步冲突', {
          name: project.name,
          count: sync.conflicts.length,
        }),
        detail: t('本机版本已另存为冲突副本'),
        actions: [{ label: t('查看'), run: () => (close(), onSyncSettings()) }],
      });
    else if (sync.lastError)
      items.push({
        key: `sync-error:${project.id}`,
        tone: 'bad',
        icon: <CircleX />,
        title: t('「{name}」同步失败', { name: project.name }),
        detail: sync.lastError,
        network: true,
        actions: [{ label: t('查看'), run: () => (close(), onSyncSettings()) }],
      });
  }
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  for (const run of data.runs) {
    const project = data.projects.find((p) => p.id === run.project && !p.archived);
    const at = typeof run.updatedAt === 'string' ? run.updatedAt : '';
    if (!project || run.status !== 'failed' || at < weekAgo || dismissed.includes(`run:${run.id}`))
      continue;
    const name = typeof run.name === 'string' && run.name ? run.name : t('运行记录');
    items.push({
      key: `run:${run.id}`,
      tone: 'bad',
      icon: <FlaskConical />,
      title: t('运行失败：{name}', { name }),
      detail: `${project.name} · ${relativeTime(at)}`,
      actions: [
        {
          label: t('查看'),
          run: () => {
            close();
            onOpenSource({
              projectId: project.id,
              workspace: 'experiments',
              resourceId: run.id,
              title: name,
            });
          },
        },
        { label: t('知道了'), run: () => dismiss(`run:${run.id}`) },
      ],
    });
  }
  const offline = !!cloud.state?.authenticated && !cloud.reachable;
  return (
    <>
      <Button
        variant="ghost"
        iconOnly
        className="sf-bell"
        aria-label={items.length ? t('通知（{count}）', { count: items.length }) : t('通知')}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={(event) => {
          const trigger = event.currentTarget;
          setAnchor((current) => (current ? null : trigger));
        }}
      >
        <Bell />
        {items.length ? <span className="sf-bell-dot" aria-hidden="true" /> : null}
      </Button>
      <Popover anchor={anchor} label={t('通知')} width={340} align="end" onClose={close}>
        <div className="sf-notice-head">{t('通知')}</div>
        {items.length ? (
          <ul className="sf-notices">
            {items.map((item) => (
              <li key={item.key} className={`sf-notice tone-${item.tone}`}>
                <span className="sf-notice-icon">{item.icon}</span>
                <div className="sf-notice-body">
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                  <div className="sf-notice-actions">
                    {item.network && offline ? (
                      <Button size="sm" disabled>
                        {t('联网后处理')}
                      </Button>
                    ) : (
                      item.actions.map((action) => (
                        <Button
                          key={action.label}
                          size="sm"
                          variant={action.primary ? 'primary' : 'ghost'}
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
          <p className="sf-notice-none">{t('没有需要处理的事项')}</p>
        )}
        {error ? (
          <p role="alert" className="error-text">
            {error}
          </p>
        ) : null}
      </Popover>
    </>
  );
}
