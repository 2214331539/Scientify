import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles.css';
import { isTauri } from '@tauri-apps/api/core';
import { createWorkspaceStore } from './stores/workspace';
import { browserResearch, browserWorkspace } from './platform/browser';
import { windowRole } from './platform/windows';
import { ProjectsWindow } from './app/ProjectsWindow';
import { WorkspaceWindow } from './app/WorkspaceWindow';
import { applyAppearance, getPreferences, setPreferences } from './i18n/preferences';

const native = isTauri();
if (native) {
  const params = new URLSearchParams(location.search);
  try {
    const prefs = JSON.parse(params.get('preferences') ?? 'null');
    if (
      prefs &&
      ['zh-CN', 'en'].includes(prefs.language) &&
      ['system', 'dark', 'light'].includes(prefs.theme)
    )
      setPreferences(prefs);
  } catch {
    /* Optional preference handoff. */
  }
  params.delete('preferences');
  history.replaceState(null, '', `${location.pathname}${params.size ? '?' + params : ''}`);
}
applyAppearance(getPreferences(), matchMedia('(prefers-color-scheme: dark)').matches);
const store = native ? undefined : createWorkspaceStore(browserWorkspace);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {native ? (
      windowRole() === 'workspace' ? (
        <WorkspaceWindow />
      ) : (
        <ProjectsWindow />
      )
    ) : (
      <App store={store} backend={browserResearch} preview />
    )}
  </StrictMode>,
);
