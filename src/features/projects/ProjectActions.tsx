import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Cloud,
  FolderOpen,
  Pencil,
  RefreshCw,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { Button } from '../../components/primitives';
import type { Project } from '../../domain/workspace';
import { t } from '../../i18n';
import { isSyncedProject } from '../../platform/collaboration';
import { isMacOS } from '../../platform/os';

export type ProjectAction =
  'open' | 'edit' | 'sync' | 'syncNow' | 'share' | 'reveal' | 'archive' | 'delete';

/** Menu items of a personal project; cloud actions say why they are unavailable. */
export function ProjectActions({
  project,
  busy,
  signedIn,
  reachable,
  onAction,
}: {
  project: Project;
  busy: boolean;
  signedIn: boolean;
  reachable: boolean;
  onAction(action: ProjectAction): void;
}) {
  const synced = isSyncedProject(project);
  const cloudBlocked = busy || !signedIn || !reachable || !!project.archived;
  const cloudHint = !signedIn ? t('需要登录') : !reachable ? t('需要联网') : '';
  const item = (
    action: ProjectAction,
    icon: React.ReactNode,
    label: string,
    disabled = busy,
    hint = '',
  ) => (
    <Button variant="ghost" role="menuitem" disabled={disabled} onClick={() => onAction(action)}>
      {icon}
      <span>{label}</span>
      {hint ? <small className="center-menu-hint">{hint}</small> : null}
    </Button>
  );
  return (
    <>
      {item('open', <ArrowUpRight />, t('打开'))}
      {item('edit', <Pencil />, t('编辑信息…'))}
      <div role="separator" className="sf-menu-separator" />
      {synced
        ? item('syncNow', <RefreshCw />, t('立即同步'), busy || !signedIn || !reachable, cloudHint)
        : item('sync', <Cloud />, t('在多台设备上同步…'), cloudBlocked, cloudHint)}
      {item('share', <UsersRound />, t('共享给团队…'), cloudBlocked, cloudHint)}
      {item(
        'reveal',
        <FolderOpen />,
        isMacOS() ? t('在 Finder 中显示文献文件夹') : t('在资源管理器中显示文献文件夹'),
      )}
      <div role="separator" className="sf-menu-separator" />
      {item(
        'archive',
        project.archived ? <ArchiveRestore /> : <Archive />,
        project.archived ? t('恢复') : t('归档'),
      )}
      <Button
        variant="ghost"
        role="menuitem"
        disabled={busy}
        className="sf-menu-danger"
        onClick={() => onAction('delete')}
      >
        <Trash2 />
        {t('删除项目…')}
      </Button>
    </>
  );
}
