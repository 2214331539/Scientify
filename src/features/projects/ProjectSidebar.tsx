import { Cloud, LogOut, UserRound, UsersRound, Settings } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/primitives';
import { Menu, type MenuAnchor } from '../../components/primitives/Menu';
import { BrandMark } from '../../components/layout/BrandMark';
import { confirmAction } from '../../components/prompts';
import { AppearanceControls } from '../settings/Appearance';
import { t } from '../../i18n';
import {
  collaboration,
  collaborationStateEvent,
  requestSignIn,
  type CollaborationState,
} from '../../platform/collaboration';
import { maskPhone } from '../account/account';
import './project-library.css';

export function ProjectSidebar({
  space,
  ready,
  onSpace,
  onSettings,
  onCollaborationSettings,
}: {
  space: string;
  ready: boolean;
  onSpace(space: string): void;
  onSettings(): void;
  onCollaborationSettings(): void;
}) {
  const teamActive = space !== 'personal';
  const [collaborationState, setCollaborationState] = useState<CollaborationState | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const signedIn = !!collaborationState?.authenticated;
  const refreshCollaboration = useCallback(() => {
    if (!isTauri()) return;
    void collaboration
      .status()
      .then(setCollaborationState)
      .catch(() => setCollaborationState(null));
  }, []);
  useEffect(() => {
    refreshCollaboration();
    window.addEventListener(collaborationStateEvent, refreshCollaboration);
    return () => {
      window.removeEventListener(collaborationStateEvent, refreshCollaboration);
    };
  }, [refreshCollaboration, space]);
  function openAccount(trigger: HTMLButtonElement) {
    if (!signedIn) {
      requestSignIn();
      return;
    }
    const rect = trigger.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.top - 6, placement: 'top', trigger });
  }
  async function signOut() {
    if (!(await confirmAction(t('退出登录后，云端项目会停止同步，本机的项目和文件会保留。'))))
      return;
    try {
      setCollaborationState(await collaboration.logout());
    } catch {
      // The refresh below shows whatever state is left.
    }
    window.dispatchEvent(new Event(collaborationStateEvent));
  }
  const phone = collaborationState?.phone ? maskPhone(collaborationState.phone) : t('已登录');
  return (
    <aside className="launcher-sidebar" aria-label={t('项目空间')}>
      <div className="launcher-brand" data-tauri-drag-region>
        <BrandMark />
        <span data-tauri-drag-region>Scientify</span>
      </div>
      <nav className="launcher-spaces" aria-label={t('空间导航')}>
        <Button
          variant="ghost"
          className="launcher-space"
          aria-current={!teamActive ? 'page' : undefined}
          disabled={!ready}
          onClick={() => onSpace('personal')}
        >
          <UserRound />
          {t('个人空间')}
        </Button>
        <Button
          variant="ghost"
          className="launcher-space"
          aria-current={teamActive ? 'page' : undefined}
          disabled={!ready}
          onClick={() => onSpace('__teams__')}
        >
          <UsersRound />
          {t('团队协作空间')}
        </Button>
      </nav>
      <footer className="launcher-sidebar-footer">
        <button
          className="launcher-profile sf-button"
          type="button"
          aria-haspopup={signedIn ? 'menu' : undefined}
          aria-expanded={signedIn ? !!menu : undefined}
          onClick={(event) => openAccount(event.currentTarget)}
        >
          <span className="launcher-avatar">
            <UserRound />
          </span>
          {signedIn ? (
            <span className="launcher-profile-text">
              <strong>{phone}</strong>
              <small>{t('已登录')}</small>
            </span>
          ) : (
            <span>{t('登录协作')}</span>
          )}
        </button>
        <div className="launcher-utilities topbar-tools" aria-label={t('全局设置')}>
          <AppearanceControls />
          <span className="spacer" />
          <Button variant="ghost" iconOnly aria-label={t('设置')} onClick={onSettings}>
            <Settings />
          </Button>
        </div>
      </footer>
      <Menu anchor={menu} label={t('账号')} onClose={() => setMenu(null)}>
        <div className="launcher-account-heading">
          <strong>{phone}</strong>
          <small>{t('已登录 Scientify 协作')}</small>
        </div>
        <div className="sf-menu-separator" />
        <Button role="menuitem" variant="ghost" onClick={() => onSpace('__teams__')}>
          <UsersRound />
          {t('团队协作空间')}
        </Button>
        <Button role="menuitem" variant="ghost" onClick={onCollaborationSettings}>
          <Cloud />
          {t('同步与协作设置')}
        </Button>
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
    </aside>
  );
}
