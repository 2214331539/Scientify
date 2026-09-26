import { t } from '../../i18n';
import { Button } from '../primitives';
import { Panel } from '../layout/Panel';
import { Sidebar } from '../layout/Sidebar';
import type { CSSProperties, ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

export function WorkspaceFrame({
  label,
  views,
  view,
  onView,
  sidebar,
  sidebarOpen,
  onSidebarToggle,
  width,
  resize,
  children,
}: {
  label: string;
  views: { id: string; label: string }[];
  view: string;
  onView: (id: string) => void;
  sidebar?: ReactNode;
  sidebarOpen: boolean;
  onSidebarToggle: () => void;
  width: number;
  resize?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Panel className="workspace-frame" aria-label={t('{label} 工作区', { label: t(label) })}>
      <header className="workspace-commandbar">
        {sidebar && (
          <Button
            variant="ghost"
            iconOnly
            className="icon-button"
            title={sidebarOpen ? t('收起资源') : t('展开资源')}
            aria-label={sidebarOpen ? t('收起资源') : t('展开资源')}
            onClick={onSidebarToggle}
          >
            {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
        )}
        <span className="workspace-name">{t(label)}</span>
        {views.length > 1 && (
          <nav className="workspace-views" aria-label={t('二级导航')}>
            {views.map((item) => (
              <Button
                variant="ghost"
                key={item.id}
                aria-current={view === item.id ? 'page' : undefined}
                onClick={() => onView(item.id)}
              >
                {t(item.label)}
              </Button>
            ))}
          </nav>
        )}
      </header>
      <div className="workspace-frame-body">
        {sidebar && (
          <>
            <Sidebar
              className="workspace-resources"
              hidden={!sidebarOpen}
              style={{ width: `${width}px` } as CSSProperties}
              aria-label={t('{label} 资源', { label: t(label) })}
            >
              {sidebar}
            </Sidebar>
            {sidebarOpen && resize}
          </>
        )}
        <div className="workspace-document">{children}</div>
      </div>
    </Panel>
  );
}
