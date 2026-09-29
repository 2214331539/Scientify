import {
  getFileSession,
  getFileRuntime,
  hasPendingFileOperations,
  hasUnsavedFileChanges,
  type FileSession,
} from '../../editor/sessions';
import { nativeLibrary, noteFiles, type LibraryBackend } from '../../platform/library';

export type LocalTab = {
  id: string;
  kind: 'pdf' | 'text' | 'web';
  title: string;
  paperId?: string;
  path?: string;
  url?: string;
};
export type LocalSession = {
  root: string | null;
  tabs: LocalTab[];
  active: string | null;
  notes: string[];
  activeNote: string | null;
  showNotes: boolean;
  noteWidth: number;
};
export const emptyLocalSession = (): LocalSession => ({
  root: null,
  tabs: [],
  active: null,
  notes: [],
  activeNote: null,
  showNotes: false,
  noteWidth: 340,
});
const liveSessions = new Map<string, LocalSession>();
export function saveLocalSession(project: string, session: LocalSession) {
  liveSessions.set(project, session);
  try {
    localStorage.setItem(`scientify.library.${project}`, JSON.stringify(session));
  } catch {
    /* Optional state. */
  }
}
export function readLocalSession(project: string): LocalSession {
  const live = liveSessions.get(project);
  if (live) return live;
  try {
    const s = JSON.parse(localStorage.getItem(`scientify.library.${project}`) ?? 'null');
    if (s && Array.isArray(s.tabs) && Array.isArray(s.notes))
      return {
        ...emptyLocalSession(),
        ...s,
        tabs: s.tabs.filter(
          (t: LocalTab) =>
            t &&
            typeof t.id === 'string' &&
            typeof t.title === 'string' &&
            ((t.kind === 'pdf' && typeof t.paperId === 'string') ||
              (t.kind === 'text' && typeof t.path === 'string') ||
              (t.kind === 'web' && (!t.url || typeof t.url === 'string'))),
        ),
        root: typeof s.root === 'string' ? s.root : null,
        active: typeof s.active === 'string' ? s.active : null,
        activeNote: typeof s.activeNote === 'string' ? s.activeNote : null,
        notes: s.notes.filter((id: unknown) => typeof id === 'string'),
        noteWidth: Math.min(500, Math.max(240, Number(s.noteWidth) || 340)),
      };
  } catch {
    /* UI state is optional. */
  }
  return emptyLocalSession();
}
export function openLocalPdf(s: LocalSession, id: string, title: string): LocalSession {
  const existing = s.tabs.find((t) => t.paperId === id && t.kind === 'pdf');
  return {
    ...s,
    tabs: existing ? s.tabs : [...s.tabs, { id: `pdf:${id}`, paperId: id, title, kind: 'pdf' }],
    active: existing?.id ?? `pdf:${id}`,
    notes: existing ? s.notes : s.notes.includes(id) ? s.notes : [...s.notes, id],
    activeNote: s.notes.includes(id) || !existing ? id : s.activeNote,
    showNotes: s.notes.includes(id) || !existing ? true : s.showNotes,
  };
}
export function openLocalText(s: LocalSession, path: string, title: string): LocalSession {
  const existing = s.tabs.find((t) => t.kind === 'text' && t.path === path);
  return {
    ...s,
    tabs: existing ? s.tabs : [...s.tabs, { id: `text:${path}`, path, title, kind: 'text' }],
    active: existing?.id ?? `text:${path}`,
  };
}
export function closeLocalTab(s: LocalSession, id: string): LocalSession {
  const i = s.tabs.findIndex((t) => t.id === id);
  const tabs = s.tabs.filter((t) => t.id !== id);
  return {
    ...s,
    tabs,
    active: s.active === id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : s.active,
  };
}

const watched = new WeakSet<FileSession>();
export function paperNote(library: LibraryBackend, project: string, id: string) {
  const note = getFileSession(noteFiles(library), project, id);
  if (!watched.has(note)) {
    watched.add(note);
    let timer: ReturnType<typeof setTimeout> | undefined;
    note.subscribe(() => {
      clearTimeout(timer);
      const state = note.getSnapshot();
      if (state.dirty && state.phase === 'ready' && !state.error)
        timer = setTimeout(() => void note.save(), 900);
    });
  }
  return note;
}
export function notesPending(library = nativeLibrary) {
  return hasPendingFileOperations(noteFiles(library));
}
export function notesDirty(library = nativeLibrary) {
  return hasUnsavedFileChanges(noteFiles(library));
}
export async function flushPaperNotes(library = nativeLibrary) {
  if (notesPending(library)) return false;
  for (const note of getFileRuntime(noteFiles(library)).sessions.values())
    if (note.getSnapshot().dirty && !(await note.save())) return false;
  return !notesDirty(library) && !notesPending(library);
}
