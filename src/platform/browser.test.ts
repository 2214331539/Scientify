import { beforeEach, expect, it } from 'vitest';
import { emptyWorkspace } from '../domain/workspace';
import { browserResearch, browserWorkspace } from './browser';

const key = 'scientify.mvp.preview.workspace.v1';
beforeEach(() => localStorage.clear());

it('treats object prototype names as ordinary filenames', async () => {
  await expect(browserResearch.readFile('p', 'constructor')).rejects.toThrow('文件不存在');
  const saved = await browserResearch.writeFile('p', '__proto__', 'research notes', null);
  expect(await browserResearch.readFile('p', '__proto__')).toEqual(saved);
  expect(await browserResearch.listFiles('p')).toEqual([
    expect.objectContaining({ path: '__proto__', kind: 'file' }),
  ]);
  await expect(browserResearch.writeFile('p', '__proto__', 'overwrite', null)).rejects.toThrow(
    '文件已修改',
  );
});

it('restores a valid backup when the main snapshot is corrupt and preserves the original', async () => {
  const backup = emptyWorkspace();
  backup.settings.name = 'Recovered';
  backup.revision = 7;
  localStorage.setItem(`${key}.backup`, JSON.stringify(backup));
  localStorage.setItem(key, '{broken');
  await expect(browserWorkspace.load()).rejects.toThrow();
  const restored = await browserWorkspace.restore();
  expect(restored).toMatchObject({ revision: 8, settings: { name: 'Recovered' } });
  expect((await browserWorkspace.load()).workspace).toEqual(restored);
  const savedKey = Object.keys(localStorage).find((entry) =>
    entry.startsWith(`${key}.before-restore.`),
  );
  expect(savedKey).toBeDefined();
  expect(localStorage.getItem(savedKey!)).toBe('{broken');
});

it('rejects incomplete backups without replacing the main snapshot', async () => {
  const main = JSON.stringify(emptyWorkspace());
  localStorage.setItem(key, main);
  localStorage.setItem(
    `${key}.backup`,
    JSON.stringify({ schema: 3, revision: 1, projects: [], records: [] }),
  );
  await expect(browserWorkspace.restore()).rejects.toThrow();
  expect(localStorage.getItem(key)).toBe(main);
});

it('advances the live revision when restoring an older backup', async () => {
  localStorage.setItem(`${key}.backup`, JSON.stringify(emptyWorkspace()));
  localStorage.setItem(key, JSON.stringify({ ...emptyWorkspace(), revision: 12 }));
  expect(await browserWorkspace.restore()).toMatchObject({ revision: 13 });
});
