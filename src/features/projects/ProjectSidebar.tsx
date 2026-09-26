import { UserRound, UsersRound, Plus, Settings, Database, CircleHelp } from 'lucide-react';
import { Button } from '../../components/primitives';
import { BrandMark } from '../../components/layout/BrandMark';
import { AppearanceControls } from '../settings/Appearance';
import type { Team } from '../../domain/workspace';
import { t } from '../../i18n';
import './project-library.css';

export function ProjectSidebar({
  space,
  teams,
  ready,
  onSpace,
  onNewTeam,
  onSettings,
  onData,
  onAbout,
}: {
  space: string;
  teams: Team[];
  ready: boolean;
  onSpace(space: string): void;
  onNewTeam(): void;
  onSettings(): void;
  onData(): void;
  onAbout(): void;
}) {
  const teamActive = space !== 'personal';
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
        {teamActive && (
          <div className="launcher-team-links">
            {teams.map((team) => (
              <Button
                variant="ghost"
                key={team.id}
                aria-current={space === team.id ? 'page' : undefined}
                onClick={() => onSpace(team.id)}
              >
                <span className="launcher-team-mark" aria-hidden="true" />{' '}
                <span className="truncate">{team.name}</span>
              </Button>
            ))}
            <Button variant="ghost" onClick={onNewTeam} disabled={!ready}>
              <Plus />
              {t('创建团队空间')}
            </Button>
          </div>
        )}
      </nav>
      <footer className="launcher-sidebar-footer">
        <div className="launcher-profile" aria-label={t('登录入口占位')}>
          <span className="launcher-avatar">
            <UserRound />
          </span>
          <span>{t('登录')}</span>
        </div>
        <div className="launcher-utilities topbar-tools" aria-label={t('全局设置')}>
          <AppearanceControls />
          <span className="spacer" />
          <Button variant="ghost" iconOnly aria-label={t('设置')} onClick={onSettings}>
            <Settings />
          </Button>
          <Button variant="ghost" iconOnly aria-label={t('数据与备份')} onClick={onData}>
            <Database />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('关于 MVP')}
            tooltip={t('关于 Scientify')}
            onClick={onAbout}
          >
            <CircleHelp />
          </Button>
        </div>
      </footer>
    </aside>
  );
}
