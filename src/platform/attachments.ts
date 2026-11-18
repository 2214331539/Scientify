import { invoke } from '@tauri-apps/api/core';

/** A file attached to a document: its path under the project's note assets, name and size. */
export type Attached = { asset: string; name: string; size: number };

const call = <T>(projectId: string, operation: Record<string, unknown>) =>
  invoke<T>('doc_attachment', { projectId, operation });

/** Chooses files with the system dialog and attaches them. */
export const pickAttachments = (projectId: string) => call<Attached[]>(projectId, { op: 'pick' });

/** Attaches a pasted or dropped file. */
export async function saveAttachment(projectId: string, file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return call<Attached>(projectId, { op: 'save', name: file.name, data: btoa(binary) });
}

/** The folder and inner path of an attachment, for the center preview. */
export const locateAttachment = (projectId: string, asset: string) =>
  call<{ root: string; path: string }>(projectId, { op: 'locate', asset });
