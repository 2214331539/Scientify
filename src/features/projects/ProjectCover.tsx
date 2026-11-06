import type { CSSProperties, ReactNode } from 'react';
import { Cloud, CloudOff, Download, UsersRound } from 'lucide-react';
import { WindowControls } from '../../components/layout/WindowControls';
import { t } from '../../i18n';
import { coverInk } from './model';
import './project-library.css';

export type CoverBadge = 'team' | 'synced' | 'offline' | 'remote';

/** The book cover that stands for a project everywhere in the project center. */
export function ProjectCoverArt({
  name,
  field,
  color,
  favorite,
  archived,
  badges = [],
}: {
  name: string;
  field?: string;
  color: string;
  favorite?: boolean;
  archived?: boolean;
  badges?: CoverBadge[];
}) {
  const icons: Record<CoverBadge, ReactNode> = {
    team: <UsersRound key="team" />,
    synced: <Cloud key="synced" />,
    offline: <CloudOff key="offline" />,
    remote: <Download key="remote" />,
  };
  return (
    <span
      className={`project-cover-art${archived ? ' archived' : ''}`}
      style={{ '--cover': color, '--cover-ink': coverInk(color) } as CSSProperties}
    >
      {favorite ? <i className="project-cover-ribbon" aria-hidden="true" /> : null}
      <span className="project-cover-field">{archived ? t('已归档') : field}</span>
      <strong className="project-cover-name">{name}</strong>
      <span className="project-cover-badges" aria-hidden="true">
        {badges.map((badge) => icons[badge])}
      </span>
    </span>
  );
}

export function MiniCover({ color }: { color: string }) {
  return (
    <span
      className="project-mini-cover"
      style={{ '--cover': color } as CSSProperties}
      aria-hidden="true"
    />
  );
}

/** Page title row of the project center; window controls sit at its right edge on Windows. */
export function CenterHeader({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <header className="center-header" data-tauri-drag-region>
      <h1 data-tauri-drag-region>
        {title}
        {count ? <span className="center-count">{count}</span> : null}
      </h1>
      <div className="center-header-actions">{children}</div>
      <WindowControls />
    </header>
  );
}

export function CenterEmpty({
  icon,
  title,
  children,
  actions,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="center-empty">
      {icon}
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
      {actions ? <div className="center-empty-actions">{actions}</div> : null}
    </div>
  );
}
