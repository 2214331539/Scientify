import { invoke } from '@tauri-apps/api/core';

export interface NoteImages {
  save(file: File): Promise<string>;
  read(path: string): Promise<string>;
}

/** Images stay on disk; Markdown contains portable relative references, not base64. */
export function noteImages(projectId: string, paperId?: string): NoteImages {
  return {
    async save(file) {
      if (
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) ||
        file.size > 8 * 1024 * 1024
      )
        throw new Error('图片需为 PNG、JPEG、WebP 或 GIF，且不超过 8 MiB。');
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      return invoke<string>('note_image', {
        projectId,
        paperId: paperId ?? null,
        operation: { op: 'save', data },
      });
    },
    read: async (path) =>
      invoke<string>('note_image', {
        projectId,
        paperId: paperId ?? null,
        operation: { op: 'read', path: decodeURI(path) },
      }),
  };
}
