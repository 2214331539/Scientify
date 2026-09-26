import { Children, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Button } from '../primitives/Button';
import './workspace-primitives.css';

export interface ResourceListProps {
  children: ReactNode;
  label?: string;
  className?: string;
  empty?: ReactNode;
}

export function ResourceList({ children, label, className = '', empty }: ResourceListProps) {
  const items = Children.toArray(children);
  return (
    <ul className={`sf-resource-list ${className}`.trim()} aria-label={label}>
      {items.length ? items : empty ? <li className="sf-list-empty">{empty}</li> : null}
    </ul>
  );
}

export interface ResourceRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
}

export function ResourceRow({
  selected = false,
  className = '',
  type = 'button',
  ...props
}: ResourceRowProps) {
  return (
    <li className="sf-resource-item">
      <Button
        {...props}
        type={type}
        variant="ghost"
        aria-current={selected ? 'true' : props['aria-current']}
        className={`sf-resource-row${selected ? ' is-selected' : ''} ${className}`.trim()}
      />
    </li>
  );
}
