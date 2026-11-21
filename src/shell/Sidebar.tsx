import {
  BookOpen,
  Bot,
  ChevronsUpDown,
  CircleHelp,
  Compass,
  FlaskConical,
  FolderClosed,
  Keyboard,
  LayoutGrid,
  LogOut,
  FileText,
  MessageSquare,
  PenLine,
  Server,
  Plus,
  Settings,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Button } from '../components/primitives';
import { Menu, type MenuAnchor } from '../components/primitives/Menu';
import { confirmAction } from '../components/prompts';
import { t } from '../i18n';
import { collaboration, collaborationStateEvent } from '../platform/collaboration';
import { browserCommand } from '../platform/browser-pane';
import { maskPhone } from '../features/account/account';
import { accountLabel, forgetProfile, loadProfile, useProfile } from '../features/account/profile';
import { useCloud } from '../features/projects/cloud';
import { coverTone, isTeamProject, type CenterPage } from '../features/projects/model';
import type { Project } from '../domain/workspace';
import type { WorkspaceId } from '../domain/context';
import './sidebar.css';

export type SettingsSection =
  | 'general'
  | 'models'
  | 'shortcuts'
  | 'collaboration'
  | 'account'
  | 'about';

const guideUrl = `https://github.com/2214331539/Scientify/blob/main/docs/${encodeURIComponent('使用说明')}/${encodeURIComponent('桌面使用说明')}.md`;
const issuesUrl = 'https://github.com/2214331539/Scientify/issues';

function openExternal(url: string) {
  if (isTauri()) void browserCommand({ op: 'external', address: url }).catch(() => {});
  else window.open(url, '_blank', 'noopener,noreferrer');
}

const roleNames: Record<string, string> = {
  owner: '所有者',
  editor: '编辑者',
  reviewer: '审阅者',
  viewer: '查看者',
};

/** Where a module puts its own resources (folders, experiments, manuscripts). */
const ResourceSlot = createContext<HTMLElement | null>(null);
export const useSidebarSlot = () => useContext(ResourceSlot);
export function SidebarSlotProvider({
  slot,
  children,
}: {
  slot: HTMLElement | null;
  children: ReactNode;
}) {
  return <ResourceSlot.Provider value={slot}>{children}</ResourceSlot.Provider>;
}

/** A module's own list in the sidebar slot: note views, experiments, manuscripts. */
export function SideGroup({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <nav className="sf-nav sf-side-group" aria-label={label}>
      <div className="sf-side-label">
        <span>{label}</span>
        {action}
      </div>
      {children}
    </nav>
  );
}

export function SideItem({
  icon,
  label,
  count,
  current,
  title,
  onClick,
}: {
  icon?: ReactNode;
  label: ReactNode;
  count?: ReactNode;
  current?: boolean;
  title?: string;
  onClick(): void;
}) {
  return (
    <Button
      variant="ghost"
      className="sf-nav-item sf-side-item"
      aria-current={current ? 'true' : undefined}
      title={title}
      onClick={onClick}
    >
      {icon}
      <span className="sf-nav-label">{label}</span>
      {count !== undefined && count !== null ? <span className="sf-nav-count">{count}</span> : null}
    </Button>
  );
}

export function ProjectMark({ project }: { project: Pick<Project, 'id' | 'color'> }) {
  return <span className="sf-mark" style={{ '--tone': coverTone(project) } as CSSProperties} />;
}

function anchorBelow(trigger: HTMLElement, placement: 'top' | 'bottom' = 'bottom'): MenuAnchor {
  const rect = trigger.getBoundingClientRect();
  return placement === 'top'
    ? { x: rect.left, y: rect.top - 6, placement, trigger }
    : { x: rect.left, y: rect.bottom + 4, trigger };
}

/** The account, settings and help in one menu; the same at both levels. */
export function SidebarFooter({ onSettings }: { onSettings(section: SettingsSection): void }) {
  const cloud = useCloud();
  const profile = useProfile();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const signedIn = !!cloud.state?.authenticated;
  const phone = cloud.state?.phone ?? '';
  useEffect(() => {
    if (signedIn) void loadProfile();
  }, [signedIn]);
  const label = signedIn ? accountLabel(profile.name, phone) || t('已登录') : t('未登录');
  const go = (section: SettingsSection) => {
    setMenu(null);
    onSettings(section);
  };
  async function signOut() {
    setMenu(null);
    if (!(await confirmAction(t('退出登录后，云端项目会停止同步，本机的项目和文件会保留。'))))
      return;
    try {
      await collaboration.logout();
    } catch {
      // The refresh below shows whatever state is left.
    }
    forgetProfile();
    window.dispatchEvent(new Event(collaborationStateEvent));
  }
  return (
    <div className="sf-side-foot">
      <button
        type="button"
        className="sf-account sf-button"
        data-tour="account"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        aria-label={t('账号与设置')}
        onClick={(event) => setMenu(anchorBelow(event.currentTarget, 'top'))}
      >
        <span className="sf-avatar" aria-hidden="true">
          {profile.name ? [...profile.name][0] : <UserRound />}
        </span>
        <span className="sf-account-name">{label}</span>
        <ChevronsUpDown className="sf-account-caret" />
      </button>
      <Menu anchor={menu} label={t('账号与设置')} onClose={() => setMenu(null)}>
        {signedIn ? (
          <>
            <div className="sf-menu-heading">
              <strong>{label}</strong>
              {profile.name && phone ? <small>{maskPhone(phone)}</small> : null}
            </div>
            <div className="sf-menu-separator" role="separator" />
          </>
        ) : null}
        <Button role="menuitem" variant="ghost" onClick={() => go('general')}>
          <Settings />
          {t('设置')}
        </Button>
        <Button role="menuitem" variant="ghost" onClick={() => go('models')}>
          <Bot />
          {t('模型设置')}
        </Button>
        {signedIn ? (
          <Button role="menuitem" variant="ghost" onClick={() => go('account')}>
            <UserRound />
            {t('账号与订阅')}
          </Button>
        ) : null}
        <div className="sf-menu-separator" role="separator" />
        <Button role="menuitem" variant="ghost" onClick={() => openExternal(guideUrl)}>
          <BookOpen />
          {t('使用说明')}
        </Button>
        <Button
          role="menuitem"
          variant="ghost"
          onClick={() => {
            setMenu(null);
            window.dispatchEvent(new Event('scientify-start-tour'));
          }}
        >
          <Compass />
          {t('功能导览')}
        </Button>
        <Button role="menuitem" variant="ghost" onClick={() => go('shortcuts')}>
          <Keyboard />
          {t('快捷键')}
        </Button>
        <Button role="menuitem" variant="ghost" onClick={() => openExternal(issuesUrl)}>
          <MessageSquare />
          {t('反馈问题')}
        </Button>
        <Button role="menuitem" variant="ghost" onClick={() => go('about')}>
          <CircleHelp />
          {t('关于 Scientify')}
        </Button>
        {signedIn ? (
          <>
            <div className="sf-menu-separator" role="separator" />
            <Button
              role="menuitem"
              variant="ghost"
              className="sf-menu-danger"
              onClick={() => void signOut()}
            >
              <LogOut />
              {t('退出登录')}
            </Button>
          </>
        ) : null}
      </Menu>
    </div>
  );
}

function NavItem({
  icon,
  label,
  current,
  count,
  alert,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  current: boolean;
  count?: number;
  alert?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <Button
      variant="ghost"
      className="sf-nav-item"
      aria-current={current ? 'page' : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span className="sf-nav-label">{label}</span>
      {alert ? <i className="sf-nav-dot" aria-label={t('有需要处理的事项')} /> : null}
      {count ? <span className="sf-nav-count">{count}</span> : null}
    </Button>
  );
}

/** The project center: the user's own projects and the team's. */
export function CenterNavigation({
  page,
  ready,
  teamAlert,
  onPage,
  footer,
}: {
  page: CenterPage;
  ready: boolean;
  teamAlert: boolean;
  onPage(page: CenterPage): void;
  footer: ReactNode;
}) {
  return (
    <aside className="sf-sidebar" aria-label={t('项目中心导航')}>
      <nav className="sf-nav" aria-label={t('项目中心页面')}>
        <NavItem
          icon={<FolderClosed />}
          label={t('我的项目')}
          current={page === 'mine'}
          disabled={!ready}
          onClick={() => onPage('mine')}
        />
        <NavItem
          icon={<UsersRound />}
          label={t('团队项目')}
          current={page === 'team'}
          alert={teamAlert}
          disabled={!ready}
          onClick={() => onPage('team')}
        />
      </nav>
      {footer}
    </aside>
  );
}

export const projectModules = [
  { id: 'literature', label: '文献', icon: BookOpen },
  { id: 'notes', label: '文档', icon: FileText },
  { id: 'experiments', label: '实验', icon: FlaskConical },
  { id: 'writing', label: '写作', icon: PenLine },
  { id: 'remote', label: '云主机', icon: Server },
] as const satisfies readonly { id: WorkspaceId; label: string; icon: unknown }[];

/** Inside a project: the project switcher (also the way back to the project center), the modules and their resources. */
export function ProjectNavigation({
  project,
  projects,
  module,
  ready,
  onModule,
  onBack,
  onSwitch,
  onProjectSettings,
  onNewProject,
  onSlot,
  footer,
}: {
  project: Project;
  projects: Project[];
  module: WorkspaceId;
  ready: boolean;
  onModule(id: WorkspaceId): void;
  onBack(page: CenterPage): void;
  onSwitch(id: string): void;
  onProjectSettings(): void;
  onNewProject(): void;
  onSlot(node: HTMLElement | null): void;
  footer: ReactNode;
}) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const team = isTeamProject(project);
  const role = project.collaborationRole ? roleNames[project.collaborationRole] : '';
  const active = projects.filter((item) => !item.archived);
  const group = (label: string, items: Project[]) =>
    items.length ? (
      <>
        <div className="sf-menu-label">{label}</div>
        {items.map((item) => (
          <Button
            key={item.id}
            role="menuitemradio"
            aria-checked={item.id === project.id}
            variant="ghost"
            onClick={() => onSwitch(item.id)}
          >
            <ProjectMark project={item} />
            <span className="sf-menu-grow">{item.name}</span>
          </Button>
        ))}
      </>
    ) : null;
  return (
    <aside className="sf-sidebar" aria-label={t('工作区导航')}>
      <button
        type="button"
        className="sf-switcher sf-button"
        aria-label={t('切换项目')}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        disabled={!ready}
        onClick={(event) => setMenu(anchorBelow(event.currentTarget))}
      >
        <ProjectMark project={project} />
        <span className="sf-switcher-text">
          <strong>{project.name}</strong>
          {role ? <small>{t(role)}</small> : null}
        </span>
        <ChevronsUpDown className="sf-switcher-caret" />
      </button>
      <nav className="sf-nav" aria-label={t('一级导航')}>
        {projectModules.map(({ id, label, icon: Icon }) => (
          <NavItem
            key={id}
            icon={<Icon />}
            label={t(label)}
            current={module === id}
            disabled={!ready}
            onClick={() => onModule(id)}
          />
        ))}
      </nav>
      <div className="sf-side-resources" ref={onSlot} />
      {footer}
      <Menu anchor={menu} label={t('项目切换')} onClose={() => setMenu(null)}>
        {group(
          t('我的项目'),
          active.filter((item) => !isTeamProject(item)),
        )}
        {group(
          t('团队项目'),
          active.filter((item) => isTeamProject(item)),
        )}
        <div className="sf-menu-separator" role="separator" />
        <Button role="menuitem" variant="ghost" onClick={onProjectSettings}>
          <Settings />
          {t('项目设置')}
        </Button>
        <Button role="menuitem" variant="ghost" onClick={() => onBack(team ? 'team' : 'mine')}>
          <LayoutGrid />
          {t('项目中心')}
        </Button>
        <Button role="menuitem" variant="ghost" onClick={onNewProject}>
          <Plus />
          {t('新建项目')}
        </Button>
      </Menu>
    </aside>
  );
}
