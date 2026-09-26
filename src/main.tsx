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
import { applyAppearance, getPreferences } from './i18n/preferences';

const native = isTauri();
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
