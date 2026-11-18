// Undoing an AI turn: the turn's unified diff (turn/diff/updated) is applied in
// reverse to each file it touched, giving the file as it was before the turn.
// A file changed again since then no longer matches the diff, and is left alone.

import { invoke } from '@tauri-apps/api/core';
import { locateFile, nativeResearch } from '../../platform/research';
import { t } from '../../i18n';

type Hunk = { newStart: number; lines: string[] };
export type FilePatch = {
  /** The path as the diff names it, relative or absolute. */
  path: string;
  added: boolean;
  deleted: boolean;
  binary: boolean;
  hunks: Hunk[];
  /** Whether the file before / after the turn ended without a newline. */
  oldNoNewline: boolean;
  newNoNewline: boolean;
};

const strip = (path: string) => path.replace(/^[ab]\//, '').trim();
const changed = () => t('有文件在这一轮之后又被改过，不能自动撤销。');

/** The files in a unified diff, with their hunks. */
export function parsePatches(diff: string): FilePatch[] {
  const patches: FilePatch[] = [];
  let current: FilePatch | null = null;
  let last = ' ';
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const target = line.match(/ b\/(.+)$/)?.[1] ?? line.slice(11);
      current = {
        path: target.trim(),
        added: false,
        deleted: false,
        binary: false,
        hunks: [],
        oldNoNewline: false,
        newNoNewline: false,
      };
      patches.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode')) current.added = true;
    else if (line.startsWith('deleted file mode')) current.deleted = true;
    else if (line.startsWith('Binary files')) current.binary = true;
    else if (line.startsWith('--- ')) {
      if (line.slice(4).trim() === '/dev/null') current.added = true;
    } else if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target === '/dev/null') current.deleted = true;
      else current.path = strip(target);
    } else if (line.startsWith('@@')) {
      const start = line.match(/\+(\d+)/);
      current.hunks.push({ newStart: start ? Number(start[1]) : 1, lines: [] });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" belongs to the line before it.
      if (last === '-') current.oldNoNewline = true;
      else if (last === '+') current.newNoNewline = true;
      else {
        current.oldNoNewline = true;
        current.newNoNewline = true;
      }
    } else if (current.hunks.length && /^[ +-]/.test(line)) {
      current.hunks.at(-1)!.lines.push(line);
      last = line[0];
    }
  }
  return patches;
}

/** The file before the turn, from its text after the turn; throws when they don't match. */
export function reverse(current: string, patch: FilePatch): string {
  const crlf = current.includes('\r\n');
  const lines = current.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out: string[] = [];
  let at = 0;
  for (const hunk of patch.hunks) {
    const start = Math.max(0, hunk.newStart - 1);
    while (at < start && at < lines.length) out.push(lines[at++]);
    for (const line of hunk.lines) {
      const text = line.slice(1).replace(/\r$/, '');
      if (line[0] === '-') {
        out.push(text);
        continue;
      }
      if ((lines[at] ?? '').replace(/\r$/, '') !== text) throw new Error(changed());
      if (line[0] === ' ') out.push(lines[at]);
      at++;
    }
  }
  while (at < lines.length) out.push(lines[at++]);
  const text = out.join(crlf ? '\r\n' : '\n');
  return out.length && !patch.oldNoNewline ? text + (crlf ? '\r\n' : '\n') : text;
}

/** The text a file had before the turn, when it was deleted in it. */
export function original(patch: FilePatch) {
  const lines = patch.hunks.flatMap((hunk) =>
    hunk.lines.filter((line) => line[0] === '-').map((line) => line.slice(1)),
  );
  return lines.join('\n') + (lines.length && !patch.oldNoNewline ? '\n' : '');
}

const normal = (path: string) =>
  path
    .replace(/\\/g, '/')
    .replace(/^\/\/\?\//, '')
    .toLowerCase();

/** The absolute path of a diff entry, among the files the turn reported. */
export function resolvePath(path: string, files: string[], cwd?: string | null) {
  const wanted = normal(path);
  const found = files.find((file) => {
    const candidate = normal(file);
    return candidate === wanted || candidate.endsWith(`/${wanted}`);
  });
  if (found) return found;
  if (/^(?:[a-z]:[\\/]|\/)/i.test(path)) return path;
  return cwd ? `${cwd.replace(/[\\/]+$/, '')}/${path}` : null;
}

/** Puts every file the turn changed back as it was; returns the files it could not. */
export async function undoTurn(
  projectId: string,
  diff: string,
  files: string[],
  cwd?: string | null,
): Promise<{ restored: number; skipped: string[] }> {
  const patches = parsePatches(diff);
  // Work out everything first, so a mismatch in one file changes nothing.
  const plan: { path: string; content: string | null }[] = [];
  const skipped: string[] = [];
  for (const patch of patches) {
    const path = resolvePath(patch.path, files, cwd);
    if (!path || patch.binary) {
      skipped.push(patch.path);
      continue;
    }
    const located = await locateFile(projectId, path);
    if (patch.deleted) {
      // Something put there since would be lost.
      if (located) throw new Error(changed());
      plan.push({ path, content: original(patch) });
      continue;
    }
    if (!located) {
      if (!patch.added) skipped.push(patch.path);
      continue;
    }
    const file = await nativeResearch.readFile(projectId, located.path, located.root);
    const before = reverse(file.content, patch);
    if (patch.added && before) throw new Error(changed());
    plan.push({ path, content: patch.added ? null : before });
  }
  for (const step of plan)
    await invoke('research_restore_file', { projectId, path: step.path, content: step.content });
  return { restored: plan.length, skipped };
}
