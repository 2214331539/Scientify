import type { HTMLAttributes } from 'react';
import './primitives.css';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}

/** Status labels only; names, counts and categories should remain ordinary text. */
export function Badge({ tone = 'neutral', className = '', ...props }: BadgeProps) {
  return <span {...props} className={`sf-badge sf-badge-${tone} ${className}`.trim()} />;
}
