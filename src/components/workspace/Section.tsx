import { useId, type ReactNode } from 'react';
import './workspace-primitives.css';

export interface SectionProps {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}

export function Section({ title, actions, children, className = '', id }: SectionProps) {
  const generatedId = useId();
  const headingId = `${id || generatedId}-heading`;
  return (
    <section id={id} className={`sf-section ${className}`.trim()} aria-labelledby={headingId}>
      <header className="sf-section-header">
        <h2 id={headingId}>{title}</h2>
        {actions ? <div className="sf-section-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}
