import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getPreferences } from '../i18n/preferences';

export function windowRole(): 'projects' | 'workspace' | 'browser' {
  if (!isTauri()) return 'browser';
  const label = getCurrentWindow().label;
  return label === 'workspace' ? label : 'projects';
}

export function openProjectWindow(projectId: string, target?: unknown) {
  return invoke('open_project_window', {
    projectId,
    target: target ? JSON.stringify(target) : null,
    preferences: getPreferences(),
  });
}
