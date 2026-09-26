import type { CSSProperties, ReactNode } from 'react';
import './layout.css';
export const WORKSPACE_RAIL_WIDTH = 48;

/** Layout owns geometry; project data, navigation and editors remain in their existing owners. */
export function AppShell({
  topbar,
  rail,
  children,
  statusbar,
  dialogs,
  rightWidth,
  variant = 'workspace',
}: {
  topbar: ReactNode;
  rail: ReactNode;
  children: ReactNode;
  statusbar: ReactNode;
  dialogs: ReactNode;
  rightWidth: number;
  variant?: 'workspace' | 'launcher';
}) {
  return (
    <div
      className={`app-shell research-shell${variant === 'launcher' ? ' launcher-shell' : ''}`}
      style={
        {
          '--dock-width': `${rightWidth}px`,
          '--sf-rail-width': `${WORKSPACE_RAIL_WIDTH}px`,
        } as CSSProperties
      }
    >
      {topbar}
      <div className="shell-body">
        {rail}
        <div className="workspace-stage">{children}</div>
      </div>
      {statusbar}
      {dialogs}
    </div>
  );
}
