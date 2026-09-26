import { Pencil, Star, Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { Button } from '../../components/primitives';
import type { Project } from '../../domain/workspace';
import { t } from '../../i18n';

export function ProjectActions({
  project,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  project: Project;
  busy: boolean;
  onEdit(): void;
  onToggle(key: 'favorite' | 'archived'): void;
  onDelete(): void;
}) {
  return (
    <>
      <Button variant="ghost" role="menuitem" disabled={busy} onClick={onEdit}>
        <Pencil />
        {t('重命名 / 编辑')}
      </Button>
      <Button variant="ghost" role="menuitem" disabled={busy} onClick={() => onToggle('favorite')}>
        <Star />
        {project.favorite ? t('取消收藏') : t('收藏')}
      </Button>
      <Button variant="ghost" role="menuitem" disabled={busy} onClick={() => onToggle('archived')}>
        {project.archived ? <ArchiveRestore /> : <Archive />}
        {project.archived ? t('恢复') : t('归档')}
      </Button>
      <div role="separator" className="sf-menu-separator" />
      <Button
        variant="ghost"
        role="menuitem"
        disabled={busy}
        className="sf-menu-danger"
        onClick={onDelete}
      >
        <Trash2 />
        {t('删除项目')}
      </Button>
    </>
  );
}
