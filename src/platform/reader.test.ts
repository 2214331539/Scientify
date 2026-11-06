import { beforeEach, expect, it, vi } from 'vitest';
import { outlineMetadata } from './reader';
import type { PdfOutline } from '../reader/pdf-outline';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
beforeEach(() => localStorage.clear());

it('preserves edited headings on reopen and rejects a stale window without losing changes', async () => {
  const outline: PdfOutline = {
    version: 1,
    source: 'detected',
    customized: false,
    entries: [{ id: 'a', title: 'Original', level: 0, page: 1 }],
  };
  const first = await outlineMetadata('0123456789abcdef');
  expect(first.outline).toBeNull();
  const created = await outlineMetadata('0123456789abcdef', outline, first.revision);
  const corrected = {
    ...outline,
    customized: true,
    entries: [{ ...outline.entries[0], title: 'Corrected' }],
  };
  await outlineMetadata('0123456789abcdef', corrected, created.revision);
  await expect(outlineMetadata('0123456789abcdef', outline, created.revision)).rejects.toThrow(
    '其他窗口',
  );
  expect((await outlineMetadata('0123456789abcdef')).outline).toEqual(corrected);
  expect((await outlineMetadata('abcdef0123456789')).outline).toBeNull();
});
