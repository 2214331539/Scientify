export type DiffRow = {
  oldNumber?: number;
  newNumber?: number;
  oldText?: string;
  newText?: string;
  kind: 'context' | 'change' | 'heading';
};
export function splitPatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let old = 0,
    next = 0;
  let inHunk = false;
  const removed: DiffRow[] = [];
  const added: DiffRow[] = [];
  function flush() {
    for (let i = 0; i < Math.max(removed.length, added.length); i++)
      rows.push({ ...removed[i], ...added[i], kind: 'change' });
    removed.length = 0;
    added.length = 0;
  }
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush();
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: 'heading', oldText: line, newText: line });
    } else if (inHunk && line.startsWith('-'))
      removed.push({ kind: 'change', oldNumber: old++, oldText: line.slice(1) });
    else if (inHunk && line.startsWith('+'))
      added.push({ kind: 'change', newNumber: next++, newText: line.slice(1) });
    else if (inHunk && line.startsWith(' ')) {
      flush();
      rows.push({
        kind: 'context',
        oldNumber: old++,
        newNumber: next++,
        oldText: line.slice(1),
        newText: line.slice(1),
      });
    }
  }
  flush();
  return rows;
}
