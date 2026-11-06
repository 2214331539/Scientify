import {
  Cloud,
  CircleHelp,
  FolderClosed,
  House,
  Inbox,
  LogOut,
  Search,
  Settings,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { useState } from 'react';
import { Button } from '../../components/primitives';
import { Menu, type MenuAnchor } from '../../components/primitives/Menu';
import { BrandMark } from '../../components/layout/BrandMark';
import { confirmAction } from '../../components/prompts';
import { t } from '../../i18n';
import { setPreferences, usePreferences, type Theme } from '../../i18n/preferences';
import {
  collaboration,
  collaborationStateEvent,
  requestSignIn,
} from '../../platform/collaboration';
import { browserCommand } from '../../platform/browser-pane';
import { isMacOS } from '../../platform/os';
import { maskPhone } from '../account/account';
import { useCloud } from './cloud';
import { MiniCover } from './ProjectCover';
import type { CenterPage } from './model';
import './project-library.css';

export type SettingsSection = 'general' | 'shortcuts' | 'collaboration' | 'about';

const guideUrl = `https://github.com/2214331539/Scientify/blob/main/docs/${encodeURIComponent('使用说明')}/${encodeURIComponent('桌面使用说明')}.md`;
const issuesUrl = 'https://github.com/2214331539/Scientify/issues';

function openExternal(url: string) {
  if (isTauri()) void browserCommand({ op: 'external', address: url }).catch(() => {});
  else window.open(url, '_blank', 'noopener,noreferrer');
}

export type FavoriteProject = { id: string; name: string; color: string; team: boolean };

export function ProjectSidebar({
  page,
  ready,
  counts,
  teamAlert,
  favorites,
  onPage,
  onOpen,
  onSearch,
  onSettings,
}: {
  page: CenterPage;
  ready: boolean;
  counts: { mine: number; team: number; inbox: number };
  teamAlert: boolean;
  favorites: FavoriteProject[];
  onPage(page: CenterPage): void;
  onOpen(id: string): void;
  onSearch(): void;
  onSettings(section: SettingsSection): void;
}) {
  const cloud = useCloud();
  const preferences = usePreferences();
  const [menu, setMenu] = useState<{ kind: 'account' | 'help'; anchor: MenuAnchor } | null>(null);
  const [favoritesOpen, setFavoritesOpen] = useState(true);
  const signedIn = !!cloud.state?.authenticated;
  const phone = cloud.state?.phone ? maskPhone(cloud.state.phone) : t('已登录');
  const mod = isMacOS() ? '⌘' : 'Ctrl ';
  function openMenu(kind: 'account' | 'help', trigger: HTMLElement) {
    const rect = trigger.getBoundingClientRect();
    setMenu({ kind, anchor: { x: rect.left, y: rect.top - 6, placement: 'top', trigger } });
  }
  async function signOut() {
    setMenu(null);
    if (!(await confirmAction(t('退出登录后，云端项目会停止同步，本机的项目和文件会保留。'))))
      return;
    try {
      await collaboration.logout();
    } catch {
      // The refresh below shows whatever state is left.
    }
    window.dispatchEvent(new Event(collaborationStateEvent));
  }
  const nav = (
    id: CenterPage,
    icon: React.ReactNode,
    label: string,
    count: number,
    alert = false,
  ) => (
    <Button
      variant="ghost"
      className="center-nav-item"
      aria-current={page === id ? 'page' : undefined}
      disabled={!ready}
      onClick={() => onPage(id)}
    >
      {icon}
      <span>{label}</span>
      {alert ? <i className="center-nav-dot" aria-label={t('有需要处理的事项')} /> : null}
      {count ? <span className="center-nav-count">{count}</span> : null}
    </Button>
  );
  const syncLabel = !cloud.reachable
    ? t('无法连接协作服务')
    : cloud.loading
      ? t('正在同步…')
      : t('已连接');
  return (
    <aside className="center-sidebar" aria-label={t('项目中心导航')}>
      <div className="center-brand" data-tauri-drag-region>
        <BrandMark />
        <span data-tauri-drag-region>Scientify</span>
      </div>
      <Button variant="ghost" className="center-search" disabled={!ready} onClick={onSearch}>
        <Search />
        <span>{t('搜索')}</span>
        <kbd>{`${mod}K`}</kbd>
      </Button>
      <nav className="center-nav" aria-label={t('项目中心页面')}>
        {nav('home', <House />, t('首页'), 0)}
        {nav('mine', <FolderClosed />, t('我的项目'), counts.mine)}
        {nav('team', <UsersRound />, t('团队项目'), counts.team, teamAlert)}
        {nav('inbox', <Inbox />, t('收集箱'), counts.inbox)}
      </nav>
      {favorites.length ? (
        <section className="center-favorites" aria-label={t('收藏的项目')}>
          <Button
            variant="ghost"
            className="center-section-toggle"
            aria-expanded={favoritesOpen}
            onClick={() => setFavoritesOpen((value) => !value)}
          >
            {t('收藏')}
          </Button>
          {favoritesOpen
            ? favorites.map((project) => (
                <Button
                  key={project.id}
                  variant="ghost"
                  className="center-favorite"
                  disabled={!ready}
                  title={t('打开“{name}”', { name: project.name })}
                  onClick={() => onOpen(project.id)}
                >
                  <MiniCover color={project.color} />
                  <span>{project.name}</span>
                  {project.team ? <UsersRound aria-label={t('团队项目')} /> : null}
                </Button>
              ))
            : null}
        </section>
      ) : null}
      <footer className="center-sidebar-footer">
        <button
          className="center-account sf-button"
          type="button"
          aria-haspopup={signedIn ? 'menu' : undefined}
          aria-expanded={signedIn ? menu?.kind === 'account' : undefined}
          aria-label={signedIn ? t('账号 {phone}', { phone }) : t('登录')}
          onClick={(event) =>
            signedIn ? openMenu('account', event.currentTarget) : requestSignIn()
          }
        >
          <span className="center-avatar">
            <UserRound />
          </span>
          <span className="center-account-text">
            <strong>{signedIn ? phone : t('登录')}</strong>
            <small>
              {signedIn ? (
                <>
                  <i className={`center-sync-dot${cloud.reachable ? '' : ' off'}`} />
                  <span>{syncLabel}</span>
                </>
              ) : (
                <span>{t('本机使用，不同步')}</span>
              )}
            </small>
          </span>
        </button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('帮助')}
          aria-haspopup="menu"
          onClick={(event) => openMenu('help', event.currentTarget)}
        >
          <CircleHelp />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('设置')}
          onClick={() => onSettings('general')}
        >
          <Settings />
        </Button>
      </footer>
      <Menu
        anchor={menu?.kind === 'account' ? menu.anchor : null}
        label={t('账号')}
        onClose={() => setMenu(null)}
      >
        <div className="launcher-account-heading">
          <strong>{phone}</strong>
          <small>{t('已登录 Scientify 协作')}</small>
        </div>
        <div className="sf-menu-separator" />
        <Button
          role="menuitem"
          variant="ghost"
          onClick={() => {
            setMenu(null);
            onPage('team');
          }}
        >
          <UsersRound />
          {t('团队项目')}
        </Button>
        <Button
          role="menuitem"
          variant="ghost"
          onClick={() => {
            setMenu(null);
            onSettings('collaboration');
          }}
        >
          <Cloud />
          {t('同步与协作设置')}
        </Button>
        <div className="center-theme" role="group" aria-label={t('界面主题')}>
          {(
            [
              ['system', t('跟随系统')],
              ['light', t('浅色')],
              ['dark', t('深色')],
            ] as [Theme, string][]
          ).map(([value, label]) => (
            <Button
              key={value}
              variant="ghost"
              size="sm"
              aria-pressed={preferences.theme === value}
              onClick={() => setPreferences({ theme: value })}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="sf-menu-separator" />
        <Button
          role="menuitem"
          variant="ghost"
          className="sf-menu-danger"
          onClick={() => void signOut()}
        >
          <LogOut />
          {t('退出登录')}
        </Button>
      </Menu>
      <Menu
        anchor={menu?.kind === 'help' ? menu.anchor : null}
        label={t('帮助')}
        onClose={() => setMenu(null)}
      >
        <Button
          role="menuitem"
          variant="ghost"
          onClick={() => {
            setMenu(null);
            openExternal(guideUrl);
          }}
        >
          {t('使用说明')}
        </Button>
        <Button
          role="menuitem"
          variant="ghost"
          onClick={() => {
            setMenu(null);
            onSettings('shortcuts');
          }}
        >
          {t('快捷键')}
        </Button>
        <Button
          role="menuitem"
          variant="ghost"
          onClick={() => {
            setMenu(null);
            openExternal(issuesUrl);
          }}
        >
          {t('反馈问题')}
        </Button>
        <div className="sf-menu-separator" />
        <Button
          role="menuitem"
          variant="ghost"
          onClick={() => {
            setMenu(null);
            onSettings('about');
          }}
        >
          {t('关于 Scientify')}
        </Button>
      </Menu>
    </aside>
  );
}
