import { App } from './App';

/** Native research entry: receives its project through the window URL. */
export function WorkspaceWindow() {
  return <App windowMode="workspace" />;
}
