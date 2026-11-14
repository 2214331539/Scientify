import type { CSSProperties, ReactNode } from 'react';
import { t } from '../../i18n';
import { toneOf } from './model';
import './project-library.css';

/** The book cover that stands for a project in the project center. */
export function ProjectCoverArt({
  name,
  field,
  question,
  color,
  archived,
}: {
  name: string;
  field?: string;
  question?: string;
  color: string;
  archived?: boolean;
}) {
  return (
    <span
      className={`project-cover-art${archived ? ' archived' : ''}`}
      style={{ '--cover': toneOf(color) } as CSSProperties}
    >
      <span className="project-cover-field">{archived ? t('已归档') : field}</span>
      <strong className="project-cover-name">{name}</strong>
      {question ? <span className="project-cover-question">{question}</span> : null}
    </span>
  );
}

export function MiniCover({ color }: { color: string }) {
  return (
    <span
      className="project-mini-cover"
      style={{ '--cover': toneOf(color) } as CSSProperties}
      aria-hidden="true"
    />
  );
}

/** Page title and the page's actions. */
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
    <header className="center-header">
      <h1>
        {title}
        {count ? <span className="center-count">{count}</span> : null}
      </h1>
      <div className="center-header-actions">{children}</div>
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
