import { t } from '../../i18n';
import { Button, Input } from '../primitives';
import { isTauri } from '@tauri-apps/api/core';
import { WindowControls } from './WindowControls';
import { BrandMark } from './BrandMark';
import { AppearanceControls } from '../../features/settings/Appearance';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FolderOpen, Plus } from 'lucide-react';
import type { Project } from '../../domain/workspace';
import { browserLayout } from '../../platform/browser-pane';

export function TopBar({
  project,
  projects,
  ready,
  onProject,
  onProjects,
  onNewProject,
  onProjectSettings,
}: {
  project?: Project;
  projects: Project[];
  ready: boolean;
  onProject: (id: string) => void;
  onProjects: () => void;
  onNewProject: () => void;
  onProjectSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const holder = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!holder.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);
  const select = (action: () => void) => {
    setOpen(false);
    setQuery('');
    action();
    trigger.current?.focus();
  };
  return (
    <header
      className={`topbar app-topbar${isTauri() ? ' native-topbar' : ''}`}
      data-tauri-drag-region
    >
      <Button
        variant="ghost"
        className="brand"
        aria-label={t('Scientify 项目管理')}
        onClick={onProjects}
      >
        <BrandMark />
        <span>Scientify</span>
      </Button>
      <span className="topbar-divider" />
      <div className="project-switcher" ref={holder}>
        <Button
          variant="ghost"
          className="project-switcher-trigger text-button"
          ref={trigger}
          aria-label={t('切换项目')}
          aria-expanded={open}
          disabled={!ready}
          onClick={() => {
            if (!open && isTauri())
              void browserLayout({ op: 'hideAll' })
                .catch(() => {})
                .then(() => setOpen(true));
            else setOpen(!open);
            setQuery('');
          }}
        >
          <span>{project?.name || t('Projects')}</span>
          <ChevronDown size={13} />
        </Button>
        {open && (
          <div
            className="project-switcher-popover"
            role="dialog"
            data-native-overlay="true"
            aria-label={t('项目切换')}
          >
            <Input
              autoFocus
              aria-label={t('筛选项目')}
              placeholder={t('Find project…')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="project-switcher-list">
              {projects
                .filter((p) => !p.archived && p.name.toLowerCase().includes(query.toLowerCase()))
                .map((p) => (
                  <Button
                    key={p.id}
                    variant="ghost"
                    className="project-switcher-row"
                    onClick={() => select(() => onProject(p.id))}
                  >
                    <FolderOpen size={14} />
                    <span>{p.name}</span>
                    {p.id === project?.id && <Check size={13} />}
                  </Button>
                ))}
            </div>
            <div className="project-switcher-footer">
              {project && (
                <Button
                  variant="ghost"
                  title={t('项目设置')}
                  onClick={() => select(onProjectSettings)}
                >
                  {t('项目设置')}
                </Button>
              )}
              <Button variant="ghost" onClick={() => select(onProjects)}>
                {t('All projects')}
              </Button>
              <Button variant="ghost" onClick={() => select(onNewProject)}>
                <Plus size={13} />
                {t('新建项目')}
              </Button>
            </div>
          </div>
        )}
      </div>
      <span className="spacer topbar-drag-region" data-tauri-drag-region />
      <div className="topbar-tools">
        <AppearanceControls />
      </div>
      <WindowControls />
    </header>
  );
}
