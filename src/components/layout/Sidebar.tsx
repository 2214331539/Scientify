import type { ComponentProps } from 'react';

/** A region inside the shell or workspace, never a second owner of navigation state. */
export function Sidebar({ className = '', ...props }: ComponentProps<'aside'>) {
  return <aside className={`sf-sidebar ${className}`} {...props} />;
}
