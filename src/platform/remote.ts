import { invoke, isTauri } from '@tauri-apps/api/core';
import type { FileBackend } from './research';
import type { TerminalInfo } from '../workspaces/experiments/development';

/** A host named in `~/.ssh/config`. */
export type RemoteHost = {
  alias: string;
  hostName?: string | null;
  user?: string | null;
  port?: string | null;
};
export type RemoteConnection = { id: string; target: string; home: string };
export type RemoteEntry = {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  link: boolean;
  size: number;
  modified: number;
};
export type RemoteFile = { path: string; content: string; version: string };

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error('云主机只能在 Scientify 桌面应用中连接。'));
  return invoke<T>(name, args);
}

/** The host refused the key; it wants a password. */
export const needsPassword = (error: unknown) => String(error).includes('AUTH:');
/** The connection dropped; connect again. */
export const disconnected = (error: unknown) => String(error).includes('DISCONNECTED:');
/** The words of an error, without the marker the page acts on. */
export const remoteMessage = (error: unknown) =>
  String(error)
    .replace(/^Error:\s*/, '')
    .replace(/^(AUTH|DISCONNECTED):/, '');

export const remote = {
  hosts: () => command<RemoteHost[]>('remote_hosts'),
  connect: (target: string, password?: string) =>
    command<RemoteConnection>('remote_connect', { target, password: password ?? null }),
  disconnect: (id: string) => command<void>('remote_disconnect', { id }),
  list: (id: string, path: string) => command<RemoteEntry[]>('remote_list', { id, path }),
  resolve: (id: string, path: string) => command<string>('remote_resolve', { id, path }),
  read: (id: string, path: string) => command<RemoteFile>('remote_read', { id, path }),
  write: (id: string, path: string, content: string, expectedVersion: string | null) =>
    command<RemoteFile>('remote_write', { id, path, content, expectedVersion }),
  create: (id: string, path: string, directory: boolean) =>
    command<void>('remote_create', { id, path, directory }),
  rename: (id: string, from: string, to: string) =>
    command<void>('remote_rename', { id, from, to }),
  delete: (id: string, path: string) => command<void>('remote_delete', { id, path }),
  terminal: (projectId: string, id: string, path: string) =>
    command<TerminalInfo>('remote_terminal', { projectId, id, path }),
};
export type RemoteApi = typeof remote;

const backends = new WeakMap<RemoteApi, Map<string, FileBackend>>();
/** Files on a host for the editor's buffers, which save with the version they read. */
export function remoteFiles(connection: string, api: RemoteApi = remote): FileBackend {
  let byConnection = backends.get(api);
  if (!byConnection) backends.set(api, (byConnection = new Map()));
  let backend = byConnection.get(connection);
  if (!backend) {
    backend = {
      readFile: (_project, path) => api.read(connection, path),
      writeFile: (_project, path, content, expected) =>
        api.write(connection, path, content, expected),
    };
    byConnection.set(connection, backend);
  }
  return backend;
}

export const parentOf = (path: string) => path.replace(/\/[^/]+\/?$/, '') || '/';
export const nameOf = (path: string) => path.replace(/\/+$/, '').split('/').at(-1) || '/';
export const joinPath = (folder: string, name: string) => `${folder.replace(/\/+$/, '')}/${name}`;
/** `~/x` in the host's terms. */
export const expandHome = (path: string, home: string) =>
  path === '~' ? home : path.startsWith('~/') ? joinPath(home, path.slice(2)) : path;
