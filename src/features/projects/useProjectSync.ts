import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  collaboration,
  collaborationStateEvent,
  projectSyncRequestEvent,
  type CollaborationState,
  type ProjectSyncState,
} from '../../platform/collaboration';
import type { WorkspaceStore } from '../../stores/workspace';
import { translateError } from '../../i18n';

/** The open workspace owns scheduling; all entry points use the same native sync lock. */
export function useProjectSync(projectId: string, store: WorkspaceStore, automatic: boolean) {
  const [info, setInfo] = useState<ProjectSyncState | null>(null);
  const [account, setAccount] = useState<CollaborationState | null>(null);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const active = useRef(true);
  const refreshId = useRef(0);
  const running = useRef(false);
  const reloadPending = useRef(false);
  const refresh = useCallback(async () => {
    const id = ++refreshId.current;
    try {
      const [account, info] = await Promise.all([
        collaboration.status(),
        collaboration.syncState(projectId),
      ]);
      if (active.current && id === refreshId.current) {
        setAccount(account);
        setInfo(info);
        setReadError('');
        // A failure from before sign-out says nothing about the current state.
        if (!account.enabled || !account.authenticated) setError('');
      }
    } catch (reason) {
      if (active.current && id === refreshId.current) setReadError(translateError(String(reason)));
    }
  }, [projectId]);
  const sync = useCallback(async () => {
    if (running.current || !navigator.onLine) return;
    running.current = true;
    try {
      const [account, info] = await Promise.all([
        collaboration.status(),
        collaboration.syncState(projectId),
      ]);
      if (
        !account.enabled ||
        !account.authenticated ||
        info.paused ||
        info.syncing ||
        !active.current
      )
        return;
      setSyncing(true);
      setError('');
      const outcome = await collaboration.syncProject(projectId);
      if (outcome.changed.some((kind) => ['project', 'record', 'experiment', 'run'].includes(kind)))
        reloadPending.current = true;
      if (outcome.errors.length && active.current)
        setError(outcome.errors.map(translateError).join('\n'));
    } catch (reason) {
      if (active.current) setError(translateError(String(reason)));
    } finally {
      running.current = false;
      if (active.current) {
        setSyncing(false);
        if (reloadPending.current) reloadPending.current = !(await store.getState().refreshSaved());
        await refresh();
        window.dispatchEvent(new Event(collaborationStateEvent));
      }
    }
  }, [projectId, store, refresh]);
  useEffect(() => {
    active.current = true;
    void refresh();
    let soon: number | undefined;
    const request = (event: Event) => {
      if ((event as CustomEvent<{ projectId: string }>).detail?.projectId !== projectId) return;
      window.clearTimeout(soon);
      soon = window.setTimeout(() => {
        void refresh();
        if (automatic) void sync();
      }, 3000);
    };
    const connection = () => {
      setOnline(navigator.onLine);
      if (automatic && navigator.onLine) void sync();
    };
    const changed = () => {
      void refresh();
    };
    const native = isTauri()
      ? listen<{ projectId: string }>('collaboration-updated', (e) => {
          if (e.payload.projectId === projectId) void refresh();
        })
      : Promise.resolve(() => {});
    const saved = isTauri()
      ? listen<{ projectId: string; changed: string[] }>('collaboration-synced', (e) => {
          if (
            e.payload.projectId === projectId &&
            e.payload.changed.some((kind) =>
              ['project', 'record', 'experiment', 'run'].includes(kind),
            )
          ) {
            reloadPending.current = true;
            void store
              .getState()
              .refreshSaved()
              .then((loaded) => {
                if (loaded) reloadPending.current = false;
              });
          }
        })
      : Promise.resolve(() => {});
    if (automatic) void sync();
    const timer = automatic ? window.setInterval(() => void sync(), 30000) : undefined;
    window.addEventListener(projectSyncRequestEvent, request);
    window.addEventListener(collaborationStateEvent, changed);
    window.addEventListener('online', connection);
    window.addEventListener('offline', connection);
    return () => {
      active.current = false;
      window.clearTimeout(soon);
      window.clearInterval(timer);
      window.removeEventListener(projectSyncRequestEvent, request);
      window.removeEventListener(collaborationStateEvent, changed);
      window.removeEventListener('online', connection);
      window.removeEventListener('offline', connection);
      void native.then((stop) => stop());
      void saved.then((stop) => stop());
    };
  }, [automatic, projectId, refresh, sync, store]);
  return {
    info,
    account,
    error: error || readError,
    online,
    syncing: syncing || !!info?.syncing,
    refresh,
    sync,
  };
}
