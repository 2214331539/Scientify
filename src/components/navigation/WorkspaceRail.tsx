import { t } from '../../i18n';
import { Button } from '../primitives';
import { Sidebar } from '../layout/Sidebar';
import { CircleHelp, Database, FolderOpen, Settings } from 'lucide-react';
import type { WorkspaceId } from '../../domain/context';
import { workspaceItems } from './workspaces';

export function WorkspaceRail({
  active,
  inProject,
  onNavigate,
  onProjects,
  onSettings,
  onData,
  onAbout,
}: {
  active: WorkspaceId;
  inProject: boolean;
  onNavigate: (id: WorkspaceId) => void;
  onProjects: () => void;
  onSettings: () => void;
  onData: () => void;
  onAbout: () => void;
}) {
  return (
    <Sidebar className="workspace-rail" aria-label={t('工作区导航')}>
      <nav aria-label={t('一级导航')}>
        {inProject ? (
          workspaceItems.map(({ id, label, icon: Icon }) => (
            <Button
              variant="ghost"
              iconOnly
              key={id}
              aria-label={t(label)}
              title={t(label)}
              aria-current={active === id ? 'page' : undefined}
              onClick={() => onNavigate(id)}
            >
              <Icon />
            </Button>
          ))
        ) : (
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('Projects')}
            title={t('Projects')}
            aria-current="page"
            onClick={onProjects}
          >
            <FolderOpen />
          </Button>
        )}
      </nav>
      <div className="rail-utilities">
        <Button
          variant="ghost"
          iconOnly
          title={t('数据与备份')}
          aria-label={t('数据与备份')}
          onClick={onData}
        >
          <Database />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          title={t('设置')}
          aria-label={t('设置')}
          onClick={onSettings}
        >
          <Settings />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          title={t('关于 Scientify')}
          aria-label={t('关于 MVP')}
          onClick={onAbout}
        >
          <CircleHelp />
        </Button>
      </div>
    </Sidebar>
  );
}
