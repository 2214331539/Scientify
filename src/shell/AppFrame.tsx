import type { CSSProperties, ReactNode } from 'react';
import '../components/layout/layout.css';
import './frame.css';
import { platformClass } from '../platform/os';

/** One window: title bar on top; sidebar, main surface and the right panel below. */
export function AppFrame({
  titlebar,
  sidebar,
  sidebarOpen,
  children,
  dialogs,
  rightWidth,
}: {
  titlebar: ReactNode;
  sidebar: ReactNode;
  sidebarOpen: boolean;
  children: ReactNode;
  dialogs: ReactNode;
  rightWidth: number;
}) {
  return (
    <div
      className={`app-shell research-shell sf-frame ${platformClass()}`}
      style={{ '--dock-width': `${rightWidth}px` } as CSSProperties}
    >
      {titlebar}
      <div className="sf-frame-body" data-sidebar={sidebarOpen ? 'open' : 'closed'}>
        {sidebarOpen ? sidebar : null}
        <div className="sf-frame-main">{children}</div>
      </div>
      {dialogs}
    </div>
  );
}
