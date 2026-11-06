import { useState } from 'react';
import { useStore } from 'zustand';
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleX,
  CloudCheck,
  CloudDownload,
  CloudOff,
  FolderOpen,
  Info,
  Lock,
  LogIn,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Star,
  TriangleAlert,
  Upload,
  UserPlus,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import { Button, Input } from '../../components/primitives';
import { Menu, type MenuAnchor } from '../../components/primitives/Menu';
import { confirmAction } from '../../components/prompts';
import { t, translateError } from '../../i18n';
import type { WorkspaceStore } from '../../stores/workspace';
import {
  collaboration,
  requestSignIn,
  type CollaborationMember,
  type CollaborationProject,
} from '../../platform/collaboration';
import { nativeLibrary } from '../../platform/library';
import { isMacOS } from '../../platform/os';
import { maskPhone } from '../account/account';
import {
  classifyCloud,
  isNewCloudProject,
  markCloudSeen,
  refreshCloud,
  reloadMembers,
  syncNow,
  useCloud,
  type CloudEntry,
} from './cloud';
import {
  InviteMemberDialog,
  inviteRoles,
  roleDescriptions,
  roleName,
  ShareProjectDialog,
} from './ProjectDialogs';
import { CenterEmpty, CenterHeader, MiniCover } from './ProjectCover';
import { colorForId, coverColor, relativeTime } from './model';

type Filter = 'all' | 'own' | 'shared';

function statusOf(entry: CloudEntry, reachable: boolean) {
  if (!entry.local) return { tone: 'muted', icon: <CloudDownload />, label: t('未下载') };
  if (!reachable) return { tone: 'muted', icon: <CloudOff />, label: t('离线') };
  if (entry.sync?.conflicts.length)
    return {
      tone: 'warn',
      icon: <TriangleAlert />,
      label: t('{count} 处冲突', { count: entry.sync.conflicts.length }),
    };
  if (entry.sync?.lastError) return { tone: 'bad', icon: <CircleX />, label: t('同步失败') };
  return { tone: 'ok', icon: <CloudCheck />, label: t('已同步') };
}

function Avatar({ member, me }: { member: CollaborationMember; me: boolean }) {
  return (
    <span className={`center-member-avatar${member.pending ? ' pending' : ''}`} aria-hidden="true">
      {me || member.pending ? <UserRound /> : member.phone.slice(-2)}
    </span>
  );
}

/** “团队项目”: projects shared with other people, their members and this device's copy. */
export function TeamProjects({
  store,
  onOpenRemote,
  onNewTeamProject,
  onCollaborationSettings,
}: {
  store: WorkspaceStore;
  onOpenRemote(project: CollaborationProject, team: boolean): Promise<void>;
  onNewTeamProject(): void;
  onCollaborationSettings(): void;
}) {
  const data = useStore(store, (s) => s.data)!;
  const busy = useStore(store, (s) => s.busy);
  const cloud = useCloud();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [roleMenu, setRoleMenu] = useState<{
    member: CollaborationMember;
    anchor: MenuAnchor;
  } | null>(null);
  const [inviting, setInviting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const userId = cloud.state?.userId;
  const { team } = classifyCloud(cloud, data.projects);
  const term = query.trim().toLocaleLowerCase();
  const visible = team.filter(
    (entry) =>
      (filter === 'all' ||
        (filter === 'own' ? entry.remote.role === 'owner' : entry.remote.role !== 'owner')) &&
      entry.remote.name.toLocaleLowerCase().includes(term),
  );
  const selected = visible.find((entry) => entry.remote.id === selectedId) ?? visible[0];
  async function run(key: string, task: () => Promise<void>) {
    setWorking(key);
    setError('');
    setNotice('');
    try {
      await task();
    } catch (reason) {
      setError(translateError(String(reason instanceof Error ? reason.message : reason)));
    } finally {
      setWorking(null);
    }
  }
  const open = (entry: CloudEntry) =>
    run(`open:${entry.remote.id}`, async () => {
      markCloudSeen(entry.remote.id);
      await onOpenRemote(entry.remote, true);
    });
  if (!cloud.available)
    return (
      <section className="center-page" aria-label={t('团队项目')}>
        <CenterHeader title={t('团队项目')} />
        <div className="center-scroll">
          <CenterEmpty icon={<UsersRound />} title={t('团队项目')}>
            {t('登录和协作同步需要在 Scientify 桌面应用中使用。')}
          </CenterEmpty>
        </div>
      </section>
    );
  if (!cloud.state?.authenticated)
    return (
      <section className="center-page" aria-label={t('团队项目')}>
        <CenterHeader title={t('团队项目')} />
        <div className="center-scroll">
          <CenterEmpty
            icon={<UsersRound />}
            title={t('登录后查看团队项目')}
            actions={
              <Button variant="primary" onClick={requestSignIn}>
                <LogIn />
                {t('登录')}
              </Button>
            }
          />
        </div>
      </section>
    );
  const offline = !cloud.reachable;
  const header = (
    <CenterHeader title={t('团队项目')} count={team.length}>
      {team.length ? (
        <label className="center-search-field">
          <Search aria-hidden="true" />
          <Input
            type="search"
            aria-label={t('搜索团队项目')}
            placeholder={t('搜索团队项目')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : null}
      <Button disabled={busy || offline} onClick={() => setSharing(true)}>
        <Upload />
        <span className="center-label-text">{t('共享本机项目')}</span>
      </Button>
      <Button variant="primary" disabled={busy || offline} onClick={onNewTeamProject}>
        <Plus />
        {t('新建团队项目')}
      </Button>
    </CenterHeader>
  );
  const status = offline ? (
    <p className="center-connection off" role="status">
      <CloudOff />
      <span>
        {cloud.fetchedAt
          ? t('无法连接协作服务，显示的是 {time} 的列表。', { time: relativeTime(cloud.fetchedAt) })
          : t('无法连接协作服务。')}
      </span>
      <Button variant="ghost" size="sm" onClick={() => void refreshCloud(data.projects)}>
        {t('重试')}
      </Button>
    </p>
  ) : (
    <p className="center-connection" role="status">
      <i className="center-sync-dot" />
      <span>
        {cloud.loading
          ? t('正在刷新…')
          : t('已连接协作服务 · {time}刷新', { time: relativeTime(cloud.fetchedAt) })}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={cloud.loading}
        onClick={() => void refreshCloud(data.projects)}
      >
        <RefreshCw />
        {t('刷新')}
      </Button>
    </p>
  );
  const shareDialog = sharing ? (
    <ShareProjectDialog
      store={store}
      onClose={() => setSharing(false)}
      onShared={(id) => {
        setSharing(false);
        setSelectedId(id);
      }}
    />
  ) : null;
  if (!team.length)
    return (
      <section className="center-page" aria-label={t('团队项目')}>
        {header}
        <div className="center-scroll">
          {status}
          <CenterEmpty
            icon={<UsersRound />}
            title={t('还没有团队项目')}
            actions={
              <>
                <Button variant="primary" disabled={offline} onClick={onNewTeamProject}>
                  <Plus />
                  {t('新建团队项目')}
                </Button>
                <Button disabled={offline} onClick={() => setSharing(true)}>
                  <Upload />
                  {t('共享本机项目')}
                </Button>
              </>
            }
          />
        </div>
        {shareDialog}
      </section>
    );
  const owned = team.filter((entry) => entry.remote.role === 'owner').length;
  const chip = (value: Filter, label: string, count: number) => (
    <Button
      variant="ghost"
      size="sm"
      className="center-chip"
      aria-pressed={filter === value}
      onClick={() => setFilter(value)}
    >
      {label}
      <span className="center-chip-count">{count}</span>
    </Button>
  );
  const owner = selected?.remote.role === 'owner';
  const canManage = !!selected && owner && !offline;
  const ownerMember = selected?.members?.find((member) => member.role === 'owner');
  const selectedColor = selected
    ? selected.local
      ? coverColor(selected.local)
      : colorForId(selected.remote.id)
    : '';
  return (
    <section className="center-page" aria-label={t('团队项目')}>
      {header}
      <div className="team-layout">
        <div className="team-main">
          {status}
          <div className="center-toolbar">
            <div className="center-chips" role="group" aria-label={t('筛选团队项目')}>
              {chip('all', t('全部'), team.length)}
              {chip('own', t('我创建的'), owned)}
              {chip('shared', t('共享给我的'), team.length - owned)}
            </div>
          </div>
          {error ? (
            <p role="alert" className="error-text center-error">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="center-notice">
              {notice}
            </p>
          ) : null}
          {visible.length ? (
            <div className="center-table-wrap">
              <table className="center-table team-table" aria-label={t('团队项目列表')}>
                <thead>
                  <tr>
                    <th>{t('项目')}</th>
                    <th className="wide-only">{t('我的角色')}</th>
                    <th className="wide-only">{t('成员')}</th>
                    <th>{t('本机')}</th>
                    <th>
                      <span className="sr-only">{t('打开')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((entry) => {
                    const state = statusOf(entry, cloud.reachable);
                    const people = (entry.members ?? []).filter((member) => !member.pending);
                    const fresh =
                      !entry.local &&
                      entry.remote.role !== 'owner' &&
                      isNewCloudProject(entry.remote.id);
                    return (
                      <tr
                        key={entry.remote.id}
                        aria-selected={selected?.remote.id === entry.remote.id}
                        onDoubleClick={() => void open(entry)}
                      >
                        <td>
                          <button
                            type="button"
                            className="center-row-open"
                            aria-label={t('查看“{name}”', { name: entry.remote.name })}
                            onClick={() => setSelectedId(entry.remote.id)}
                          >
                            <MiniCover
                              color={
                                entry.local ? coverColor(entry.local) : colorForId(entry.remote.id)
                              }
                            />
                            <span>
                              <strong>
                                <span>{entry.remote.name}</span>
                                {entry.local?.favorite ? <Star aria-label={t('已收藏')} /> : null}
                                {fresh ? <em className="new">{t('新加入')}</em> : null}
                              </strong>
                              <small>
                                {t('{time}更新', { time: relativeTime(entry.remote.updatedAt) })}
                              </small>
                            </span>
                          </button>
                        </td>
                        <td className="wide-only muted">{roleName(entry.remote.role)}</td>
                        <td className="wide-only">
                          <span className="center-avatars">
                            {people.slice(0, 3).map((member) => (
                              <Avatar key={member.id} member={member} me={member.id === userId} />
                            ))}
                            {people.length > 3 ? <small>+{people.length - 3}</small> : null}
                            {!entry.members ? <small className="muted">—</small> : null}
                          </span>
                        </td>
                        <td>
                          <span className={`center-pill ${state.tone}`}>
                            {state.icon}
                            {state.label}
                          </span>
                        </td>
                        <td className="center-row-actions">
                          <Button
                            size="sm"
                            disabled={busy || !!working || (!entry.local && offline)}
                            onClick={() => void open(entry)}
                          >
                            {entry.local ? t('打开') : t('下载')}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <CenterEmpty
              icon={<Search />}
              title={t('没有符合条件的团队项目')}
              actions={
                <Button
                  onClick={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                >
                  {t('清除筛选')}
                </Button>
              }
            />
          )}
        </div>
        {selected ? (
          <aside className="team-detail" aria-label={t('项目详情')}>
            <div className="team-detail-head">
              <MiniCover color={selectedColor} />
              <div>
                <strong>{selected.remote.name}</strong>
                <small>
                  {owner
                    ? t('你是所有者')
                    : t('所有者 {owner} · 你是{role}', {
                        owner: ownerMember ? maskPhone(ownerMember.phone) : '—',
                        role: roleName(selected.remote.role),
                      })}
                </small>
              </div>
            </div>
            <div className="team-detail-actions">
              <Button
                variant="primary"
                disabled={busy || !!working || (!selected.local && offline)}
                onClick={() => void open(selected)}
              >
                {selected.local ? <ArrowUpRight /> : <CloudDownload />}
                {selected.local ? t('打开项目') : t('下载并打开')}
              </Button>
              <Button
                iconOnly
                aria-label={t('更多操作')}
                aria-haspopup="menu"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenu({
                    x: rect.right - 220,
                    y: rect.bottom + 4,
                    trigger: event.currentTarget,
                  });
                }}
              >
                <MoreHorizontal />
              </Button>
            </div>
            {!selected.local ? (
              <p className="team-note">
                <Info />
                <span>{t('首次打开会下载整个项目。')}</span>
              </p>
            ) : null}
            {selected.local?.question ? (
              <section className="team-section">
                <h3>{t('研究问题')}</h3>
                <p>{selected.local.question}</p>
              </section>
            ) : null}
            <section className="team-section">
              <h3>
                {t('成员')}
                {selected.members ? (
                  <span className="center-count">
                    {selected.members.filter((member) => !member.pending).length}
                  </span>
                ) : null}
                {canManage ? (
                  <Button variant="ghost" size="sm" onClick={() => setInviting(true)}>
                    <UserPlus />
                    {t('邀请')}
                  </Button>
                ) : null}
              </h3>
              {selected.members ? (
                <ul className="team-members">
                  {selected.members.map((member) => {
                    const me = member.id === userId;
                    const editable = canManage && member.role !== 'owner' && !me;
                    const label = member.pending
                      ? t('待注册 · {role}', { role: roleName(member.role) })
                      : roleName(member.role);
                    return (
                      <li key={member.id}>
                        <Avatar member={member} me={me} />
                        <span className="team-member-text">
                          <strong>{me ? t('我') : maskPhone(member.phone)}</strong>
                          <small>
                            {member.pending
                              ? ''
                              : member.createdAt
                                ? t('{time}加入', { time: relativeTime(member.createdAt) })
                                : ''}
                          </small>
                        </span>
                        {editable ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="team-role"
                            aria-haspopup="menu"
                            aria-label={t('更改 {phone} 的角色', {
                              phone: maskPhone(member.phone),
                            })}
                            disabled={!!working}
                            onClick={(event) => {
                              const rect = event.currentTarget.getBoundingClientRect();
                              setRoleMenu({
                                member,
                                anchor: {
                                  x: rect.right - 240,
                                  y: rect.bottom + 4,
                                  trigger: event.currentTarget,
                                },
                              });
                            }}
                          >
                            {label}
                            <ChevronDown />
                          </Button>
                        ) : (
                          <span className="team-role static">{label}</span>
                        )}
                        {editable ? (
                          <Button
                            variant="ghost"
                            iconOnly
                            className="team-remove"
                            aria-label={
                              member.pending
                                ? t('撤销对 {phone} 的邀请', { phone: maskPhone(member.phone) })
                                : t('移除 {phone}', { phone: maskPhone(member.phone) })
                            }
                            disabled={!!working}
                            onClick={() =>
                              void run(`remove:${member.id}`, async () => {
                                const ok = await confirmAction(
                                  member.pending
                                    ? t('撤销对 {phone} 的邀请？', {
                                        phone: maskPhone(member.phone),
                                      })
                                    : t('移除 {phone}？对方将不再同步这个项目。', {
                                        phone: maskPhone(member.phone),
                                      }),
                                );
                                if (!ok) return;
                                await collaboration.removeMember(selected.remote.id, member.id);
                                await reloadMembers(selected.remote.id);
                                setNotice(member.pending ? t('已撤销邀请。') : t('已移除成员。'));
                              })
                            }
                          >
                            <X />
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="muted">{t('成员列表暂时无法读取。')}</p>
              )}
              {!owner ? (
                <p className="team-note">
                  <Lock />
                  <span>
                    {t('只有所有者可以管理成员。', {
                      role: roleName(selected.remote.role),
                      rights: t(roleDescriptions[selected.remote.role] ?? ''),
                    })}
                  </span>
                </p>
              ) : offline ? (
                <p className="team-note">
                  <CloudOff />
                  <span>{t('离线时不能管理成员。')}</span>
                </p>
              ) : null}
            </section>
            <section className="team-section">
              <h3>{t('同步')}</h3>
              {selected.local ? (
                <dl className="team-facts">
                  <dt>{t('本机文件夹')}</dt>
                  <dd>
                    {selected.sync?.libraryRoot ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="team-path"
                        title={selected.sync.libraryRoot}
                        onClick={() =>
                          void nativeLibrary
                            .external(selected.remote.id, '', false)
                            .catch((reason) => setError(translateError(String(reason))))
                        }
                      >
                        {selected.sync.libraryRoot}
                      </Button>
                    ) : (
                      <span className="muted">{t('第一次同步后显示')}</span>
                    )}
                  </dd>
                  <dt>{t('上次同步')}</dt>
                  <dd>{relativeTime(selected.sync?.lastSyncAt) || t('还没有同步')}</dd>
                  <dt>{t('冲突')}</dt>
                  <dd>
                    {selected.sync?.conflicts.length ? (
                      <>
                        {t('{count} 处', { count: selected.sync.conflicts.length })}
                        <Button variant="ghost" size="sm" onClick={onCollaborationSettings}>
                          {t('查看')}
                        </Button>
                      </>
                    ) : (
                      t('无')
                    )}
                  </dd>
                  {selected.sync?.lastError ? (
                    <>
                      <dt>{t('错误')}</dt>
                      <dd className="error-text">{translateError(selected.sync.lastError)}</dd>
                    </>
                  ) : null}
                </dl>
              ) : (
                <p className="muted">{t('还没有下载到这台电脑。')}</p>
              )}
              {selected.local ? (
                <Button
                  size="sm"
                  disabled={offline || !!working}
                  onClick={() =>
                    void run(`sync:${selected.remote.id}`, async () => {
                      await syncNow(selected.remote.id);
                      setNotice(t('同步完成。'));
                    })
                  }
                >
                  <RefreshCw />
                  {working === `sync:${selected.remote.id}` ? t('正在同步…') : t('立即同步')}
                </Button>
              ) : null}
            </section>
            {owner ? null : (
              <footer className="team-detail-footer">
                <Button
                  variant="ghost"
                  size="sm"
                  className="center-danger-text"
                  disabled={offline || !!working}
                  onClick={() =>
                    void run(`leave:${selected.remote.id}`, async () => {
                      const ok = await confirmAction(
                        t('退出“{name}”？本机副本会保留为个人项目。', {
                          name: selected.remote.name,
                        }),
                      );
                      if (!ok || !userId) return;
                      await collaboration.removeMember(selected.remote.id, userId);
                      if (selected.local)
                        await store.getState().update((value) => {
                          const target = value.projects.find(
                            (item) => item.id === selected.remote.id,
                          );
                          if (target) {
                            delete (target as { collaborationRole?: string }).collaborationRole;
                            target.space = 'personal';
                          }
                        });
                      await refreshCloud(store.getState().data?.projects ?? []);
                      setSelectedId(null);
                      setNotice(t('已退出项目。'));
                    })
                  }
                >
                  {t('退出项目…')}
                </Button>
              </footer>
            )}
          </aside>
        ) : null}
      </div>
      <Menu anchor={menu} label={t('更多操作')} onClose={() => setMenu(null)}>
        {selected ? (
          <>
            <Button
              role="menuitem"
              variant="ghost"
              disabled={!selected.local || offline || !!working}
              onClick={() => {
                setMenu(null);
                void run(`sync:${selected.remote.id}`, () => syncNow(selected.remote.id));
              }}
            >
              <RefreshCw />
              {t('立即同步')}
            </Button>
            <Button
              role="menuitem"
              variant="ghost"
              disabled={!selected.local}
              onClick={() => {
                setMenu(null);
                void nativeLibrary
                  .external(selected.remote.id, '', false)
                  .catch((reason) => setError(translateError(String(reason))));
              }}
            >
              <FolderOpen />
              {isMacOS() ? t('在 Finder 中显示文献文件夹') : t('在资源管理器中显示文献文件夹')}
            </Button>
            {owner ? (
              <Button
                role="menuitem"
                variant="ghost"
                disabled={offline}
                onClick={() => {
                  setMenu(null);
                  setInviting(true);
                }}
              >
                <UserPlus />
                {t('邀请成员…')}
              </Button>
            ) : null}
          </>
        ) : null}
      </Menu>
      <Menu
        anchor={roleMenu?.anchor ?? null}
        label={t('成员角色')}
        onClose={() => setRoleMenu(null)}
      >
        {roleMenu && selected
          ? inviteRoles.map((role) => (
              <Button
                key={role}
                role="menuitemradio"
                aria-checked={roleMenu.member.role === role}
                variant="ghost"
                onClick={() => {
                  const member = roleMenu.member;
                  setRoleMenu(null);
                  if (member.role === role) return;
                  void run(`role:${member.id}`, async () => {
                    await collaboration.inviteMember(selected.remote.id, member.phone, role);
                    await reloadMembers(selected.remote.id);
                    setNotice(
                      t('已把 {phone} 的角色改为{role}。', {
                        phone: maskPhone(member.phone),
                        role: roleName(role),
                      }),
                    );
                  });
                }}
              >
                <span className="center-menu-check">
                  {roleMenu.member.role === role ? <Check /> : null}
                </span>
                <span className="center-role-option">
                  <strong>{roleName(role)}</strong>
                  <small>{t(roleDescriptions[role])}</small>
                </span>
              </Button>
            ))
          : null}
      </Menu>
      {inviting && selected ? (
        <InviteMemberDialog
          projectId={selected.remote.id}
          projectName={selected.remote.name}
          onClose={() => setInviting(false)}
          onInvited={(phone) => {
            setInviting(false);
            setNotice(t('已邀请 {phone}。', { phone: maskPhone(phone) }));
            void reloadMembers(selected.remote.id).catch(() => {});
          }}
        />
      ) : null}
      {shareDialog}
    </section>
  );
}
