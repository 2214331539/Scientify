import type { ReactNode } from 'react';
import './empty-state.css';

/**
 * Every empty page looks the same: an icon, one title, at most one line of explanation, one
 * primary action and maybe one more. Extra attributes (drop targets, ids) go on the container.
 */
export function EmptyState({
  icon,
  title,
  children,
  actions,
  className,
  ...rest
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title' | 'children'>) {
  return (
    <div className={className ? `sf-empty ${className}` : 'sf-empty'} {...rest}>
      <span className="sf-empty-icon" aria-hidden="true">
        {icon}
      </span>
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
      {actions ? <div className="sf-empty-actions">{actions}</div> : null}
    </div>
  );
}

/** First-run guidance where a page needs a few steps before it is useful. */
export function EmptySteps({
  title,
  steps,
}: {
  title: string;
  steps: { title: string; detail?: ReactNode; actions?: ReactNode }[];
}) {
  return (
    <div className="sf-empty-steps">
      <strong>{title}</strong>
      <ol>
        {steps.map((step, index) => (
          <li key={step.title}>
            <span className="sf-empty-step-number">{index + 1}</span>
            <div>
              <b>{step.title}</b>
              {step.detail ? <p>{step.detail}</p> : null}
              {step.actions ? <div className="sf-empty-actions">{step.actions}</div> : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
