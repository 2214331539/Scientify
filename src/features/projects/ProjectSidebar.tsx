import { useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  UserRound,
  UsersRound,
  Plus,
  Settings,
  Pencil,
  Trash2,
  MoreHorizontal,
} from 'lucide-react';
import { Button } from '../../components/primitives';
import { Menu, menuAnchor, type MenuAnchor } from '../../components/primitives/Menu';
import { Modal } from '../../components/Modal';
import { BrandMark } from '../../components/layout/BrandMark';
import { AppearanceControls } from '../settings/Appearance';
import type { Team } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import { deleteTeam } from './model';
import { t, translateError } from '../../i18n';
import './project-library.css';

export function ProjectSidebar({
  space,
  store,
  ready,
  onSpace,
  onNewTeam,
  onEditTeam,
  onSettings,
}: {
  space: string;
  store: WorkspaceStore;
  ready: boolean;
  onSpace(space: string): void;
  onNewTeam(): void;
  onEditTeam(team: Team): void;
  onSettings(): void;
}) {
  const data = useStore(store, (s) => s.data);
  const busy = useStore(store, (s) => s.busy);
  const dirty = useStore(store, (s) => s.dirty);
  const error = useStore(store, (s) => s.error);
  const teams = data?.teams ?? [];
  const [context, setContext] = useState<{ team: Team; anchor: MenuAnchor } | null>(null);
  const [removing, setRemoving] = useState<Team | null>(null);
  const teamActive = space !== 'personal';
  const lastTeam = useRef<string | null>(null);
  if (teams.some((team) => team.id === space)) lastTeam.current = space;
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
          onClick={() =>
            onSpace(
              teamActive
                ? space
                : (teams.find((team) => team.id === lastTeam.current)?.id ??
                    teams[0]?.id ??
                    '__teams__'),
            )
          }
        >
          <UsersRound />
          {t('团队协作空间')}
        </Button>
        {teamActive && (
          <div className="launcher-team-links">
            {teams.map((team) => (
              <div
                key={team.id}
                className="launcher-team-card"
                data-active={space === team.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (!busy)
                    setContext({
                      team,
                      anchor: {
                        ...menuAnchor(event),
                        trigger: event.currentTarget.querySelector('button'),
                      },
                    });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault();
                    if (!busy)
                      setContext({
                        team,
                        anchor: { ...menuAnchor(event), trigger: event.target as HTMLElement },
                      });
                  }
                }}
              >
                <Button
                  variant="ghost"
                  className="launcher-team-select"
                  aria-current={space === team.id ? 'page' : undefined}
                  onClick={() => onSpace(team.id)}
                >
                  <span className="launcher-team-initial" aria-hidden="true">
                    {Array.from(team.name)[0]}
                  </span>
                  <span className="launcher-team-summary">
                    <strong className="truncate">{team.name}</strong>
                    <small>
                      {t('{count} 个项目', {
                        count: data?.projects.filter((p) => p.space === team.id).length ?? 0,
                      })}
                    </small>
                  </span>
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  className="launcher-team-more"
                  aria-label={t('团队操作 {name}', { name: team.name })}
                  aria-haspopup="menu"
                  aria-expanded={context?.team.id === team.id}
                  disabled={busy}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setContext({
                      team,
                      anchor: { x: rect.left, y: rect.bottom + 4, trigger: event.currentTarget },
                    });
                  }}
                >
                  <MoreHorizontal />
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              className="launcher-new-team"
              onClick={onNewTeam}
              disabled={!ready || busy}
            >
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
        </div>
      </footer>
      <Menu
        anchor={context?.anchor ?? null}
        label={context?.team.name ?? t('团队协作空间')}
        onClose={() => setContext(null)}
      >
        {context && (
          <>
            <Button variant="ghost" role="menuitem" onClick={() => onEditTeam(context.team)}>
              <Pencil />
              {t('重命名 / 编辑')}
            </Button>
            <div role="separator" className="sf-menu-separator" />
            <Button
              variant="ghost"
              role="menuitem"
              className="sf-menu-danger"
              onClick={() => {
                store.getState().clearMessage();
                setRemoving(context.team);
              }}
            >
              <Trash2 />
              {t('删除团队空间')}
            </Button>
          </>
        )}
      </Menu>
      {removing && (
        <Modal title={t('删除团队空间')} busy={busy} onClose={() => setRemoving(null)}>
          <div className="form-grid">
            <p>{t('删除团队“{name}”？其项目将移至个人空间。', { name: removing.name })}</p>
            {dirty && <p role="alert">{t('请先保存当前修改，再删除项目或团队。')}</p>}
            {error && (
              <p role="alert" className="error-text">
                {translateError(error)}
              </p>
            )}
            <footer className="dialog-footer">
              <Button disabled={busy} onClick={() => setRemoving(null)}>
                {t('取消')}
              </Button>
              <Button
                variant="primary"
                disabled={busy || dirty}
                onClick={async () => {
                  const target = removing.id;
                  if (await store.getState().update((data) => deleteTeam(data, target))) {
                    setRemoving(null);
                    if (space === target)
                      onSpace(store.getState().data?.teams[0]?.id ?? '__teams__');
                  }
                }}
              >
                {busy ? t('正在保存…') : t('确认删除')}
              </Button>
            </footer>
          </div>
        </Modal>
      )}
    </aside>
  );
}
