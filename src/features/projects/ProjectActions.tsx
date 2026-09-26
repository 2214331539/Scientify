import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Pencil, Star, Archive, ArchiveRestore, Trash2 } from 'lucide-react';
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
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    host.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [open]);
  const choose = (action: () => void) => {
    setOpen(false);
    action();
    trigger.current?.focus();
  };
  return (
    <div className="project-actions" ref={host}>
      <Button
        variant="ghost"
        iconOnly
        ref={trigger}
        aria-label={t('项目操作 {name}', { name: project.name })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        disabled={busy}
      >
        <MoreHorizontal />
      </Button>
      {open && (
        <div
          className="project-actions-menu"
          role="menu"
          aria-label={project.name}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpen(false);
              trigger.current?.focus();
            }
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              buttons[
                (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
              ]?.focus();
            }
          }}
        >
          <Button variant="ghost" role="menuitem" onClick={() => choose(onEdit)}>
            <Pencil />
            {t('编辑')}
          </Button>
          <Button
            variant="ghost"
            role="menuitem"
            onClick={() => choose(() => onToggle('favorite'))}
          >
            <Star />
            {project.favorite ? t('取消收藏') : t('收藏')}
          </Button>
          <Button
            variant="ghost"
            role="menuitem"
            onClick={() => choose(() => onToggle('archived'))}
          >
            {project.archived ? <ArchiveRestore /> : <Archive />}
            {project.archived ? t('恢复') : t('归档')}
          </Button>
          <Button
            variant="ghost"
            role="menuitem"
            className="project-delete-action"
            onClick={() => choose(onDelete)}
          >
            <Trash2 />
            {t('删除项目')}
          </Button>
        </div>
      )}
    </div>
  );
}
