import { App } from './App';

/** Native launcher entry: never restores a project into the manager window. */
export function ProjectsWindow() {
  return <App windowMode="projects" />;
}
