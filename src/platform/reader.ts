import { invoke, isTauri } from '@tauri-apps/api/core';
import type { PdfOutline } from '../reader/pdf-outline';

export interface OutlineRecord {
  outline: PdfOutline | null;
  revision: string | null;
}
export async function outlineMetadata(
  fingerprint: string,
  save?: PdfOutline,
  revision?: string | null,
): Promise<OutlineRecord> {
  if (isTauri())
    return invoke('reader_outline', {
      fingerprint,
      outline: save ?? null,
      expectedRevision: revision ?? null,
    });
  const key = `scientify.pdf-outline.v1.${fingerprint}`;
  const raw = localStorage.getItem(key);
  if (!save) return { outline: raw ? JSON.parse(raw) : null, revision: raw };
  if (raw !== revision) throw new Error('目录已在其他窗口更新，请重新载入。');
  const next = JSON.stringify(save);
  localStorage.setItem(key, next);
  return { outline: save, revision: next };
}
