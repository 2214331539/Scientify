import { UserRound, UsersRound, Settings } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/primitives';
import { BrandMark } from '../../components/layout/BrandMark';
import { AppearanceControls } from '../settings/Appearance';
import { t } from '../../i18n';
import {
  collaboration,
  collaborationStateEvent,
  type CollaborationState,
} from '../../platform/collaboration';
import './project-library.css';

export function ProjectSidebar({
  space,
  ready,
  onSpace,
  onSettings,
}: {
  space: string;
  ready: boolean;
  onSpace(space: string): void;
  onSettings(): void;
}) {
  const teamActive = space !== 'personal';
  const [collaborationState, setCollaborationState] = useState<CollaborationState | null>(null);
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
        <button className="launcher-profile sf-button" type="button" onClick={onSettings}>
          <span className="launcher-avatar">
            <UserRound />
          </span>
          <span>
            {collaborationState?.authenticated
              ? (collaborationState.phone ?? t('已登录'))
              : t('登录协作')}
          </span>
        </button>
        <div className="launcher-utilities topbar-tools" aria-label={t('全局设置')}>
          <AppearanceControls />
          <span className="spacer" />
          <Button variant="ghost" iconOnly aria-label={t('设置')} onClick={onSettings}>
            <Settings />
          </Button>
        </div>
      </footer>
    </aside>
  );
}
