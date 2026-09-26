import type { HTMLAttributes, ReactNode } from 'react';
import './panel.css';

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  header?: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
}

export function Panel({ header, toolbar, footer, children, className = '', ...props }: PanelProps) {
  return (
    <div
      {...props}
      role={props.role ?? (props['aria-label'] || props['aria-labelledby'] ? 'region' : undefined)}
      className={`sf-panel ${className}`.trim()}
    >
      {header ? <div className="sf-panel-header">{header}</div> : null}
      {toolbar ? <div className="sf-panel-toolbar">{toolbar}</div> : null}
      {children}
      {footer ? <div className="sf-panel-footer">{footer}</div> : null}
    </div>
  );
}
