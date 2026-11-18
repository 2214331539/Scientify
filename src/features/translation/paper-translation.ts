// Full-text translation of a paper: its text page by page, in chunks the
// model translates one at a time, into a Markdown page bound to the paper
// (Rust attachments.rs `paper_translation`). Pages link back to the PDF.

import { invoke } from '@tauri-apps/api/core';
import type { AIRequest } from '../../platform/research';

/** Note-pane tabs show a paper's translation under this id prefix. */
export const TRANSLATION_TAB = 'translation:';
export const translationTab = (paperId: string) => TRANSLATION_TAB + paperId;
export const isTranslationTab = (id: string) => id.startsWith(TRANSLATION_TAB);
/** The paper a note-pane tab belongs to. */
export const paperOfTab = (id: string) =>
  isTranslationTab(id) ? id.slice(TRANSLATION_TAB.length) : id;

/** Stored translation, or null when the paper has none yet. */
export const loadTranslation = (projectId: string, paperId: string) =>
  invoke<string | null>('paper_translation', { projectId, paperId, content: null });
const saveTranslation = (projectId: string, paperId: string, content: string) =>
  invoke<string | null>('paper_translation', { projectId, paperId, content });

/** A page's text as reading prose: words split at line ends joined, lines run together. */
export function readablePage(text: string) {
  return text
    .replace(/\r/g, '')
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
    .split(/\n[ \t]*\n/)
    .map((paragraph) =>
      paragraph
        .replace(/\s*\n\s*/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n\n');
}

/** Pieces of about `size` characters, cut after a sentence or a paragraph where possible. */
export function chunks(text: string, size = 1800): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const cut = Math.max(
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('. '),
      window.lastIndexOf('。'),
      window.lastIndexOf('? '),
      window.lastIndexOf('! '),
    );
    const end = cut > size * 0.5 ? cut + 1 : size;
    out.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export type TranslationPiece = { page: number; source: string; text: string | null };

/** The translation page: a title, a note on how it was made, then each page with a link to it. */
export function translationMarkdown(
  title: string,
  pieces: TranslationPiece[],
  note: string,
  pageLabel: (page: number) => string,
  pending: string,
) {
  const lines = [`# ${title}`, '', `> ${note}`, ''];
  let page = 0;
  for (const piece of pieces) {
    if (piece.page !== page) {
      page = piece.page;
      lines.push(`## [${pageLabel(page)}](scientify-page:${page})`, '');
    }
    lines.push(piece.text?.trim() || pending, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

export type TranslationJob = {
  running: boolean;
  done: number;
  total: number;
  error: string;
  content: string | null;
};

type Entry = TranslationJob & { cancel?: () => void; listeners: Set<() => void> };
const jobs = new Map<string, Entry>();
const idle: TranslationJob = { running: false, done: 0, total: 0, error: '', content: null };
const keyOf = (projectId: string, paperId: string) => `${projectId}\n${paperId}`;

function entry(projectId: string, paperId: string) {
  const key = keyOf(projectId, paperId);
  let found = jobs.get(key);
  if (!found) jobs.set(key, (found = { ...idle, listeners: new Set() }));
  return found;
}
function update(projectId: string, paperId: string, patch: Partial<TranslationJob>) {
  const current = entry(projectId, paperId);
  const next: Entry = { ...current, ...patch };
  jobs.set(keyOf(projectId, paperId), next);
  next.listeners.forEach((listener) => listener());
}

/** A translation's state, shared by every view of it, so a running one survives tab switches. */
export const translationJobs = {
  get: (projectId: string, paperId: string): TranslationJob =>
    jobs.get(keyOf(projectId, paperId)) ?? idle,
  subscribe(projectId: string, paperId: string, listener: () => void) {
    const current = entry(projectId, paperId);
    current.listeners.add(listener);
    return () => current.listeners.delete(listener);
  },
  set: update,
  cancel(projectId: string, paperId: string) {
    jobs.get(keyOf(projectId, paperId))?.cancel?.();
  },
};

export type TranslateOptions = {
  projectId: string;
  paperId: string;
  title: string;
  /** Plain text of each page, from 1. */
  pages: string[];
  /** Asks the model; `system` and `text` become the two messages. */
  ask(request: Pick<AIRequest, 'messages'>): Promise<string>;
  language: string;
  note: string;
  pageLabel(page: number): string;
  pending: string;
  /** How many pieces are translated at once. */
  parallel?: number;
};

const instructions = (language: string) =>
  `You translate excerpts of a research paper into ${language}. Translate faithfully and completely, in fluent academic ${language}. Keep formulas, symbols, numbers, citations like [12] and code as they are; give the original term in parentheses after a technical term the first time it appears. Keep section headings on their own line. Output only the translation, with no notes or explanations.`;

/** Translates the pages piece by piece, saving the page after each piece; ends when done or cancelled. */
export async function translatePaper(options: TranslateOptions) {
  const { projectId, paperId } = options;
  if (translationJobs.get(projectId, paperId).running) return;
  const pieces: TranslationPiece[] = options.pages.flatMap((text, index) =>
    chunks(readablePage(text)).map((source) => ({ page: index + 1, source, text: null })),
  );
  if (!pieces.length) throw new Error('这篇论文没有可提取的文字，可能是扫描版。');
  let cancelled = false;
  const current = entry(projectId, paperId);
  current.cancel = () => {
    cancelled = true;
  };
  const render = () =>
    translationMarkdown(options.title, pieces, options.note, options.pageLabel, options.pending);
  update(projectId, paperId, {
    running: true,
    done: 0,
    total: pieces.length,
    error: '',
    content: render(),
  });
  let next = 0;
  let done = 0;
  let saving = Promise.resolve();
  const save = () => {
    const content = render();
    update(projectId, paperId, { content, done });
    saving = saving.then(() => saveTranslation(projectId, paperId, content).then(() => {}));
    return saving;
  };
  const worker = async () => {
    while (!cancelled && next < pieces.length) {
      const piece = pieces[next++];
      piece.text = await options.ask({
        messages: [
          { role: 'system', content: instructions(options.language) },
          { role: 'user', content: piece.source },
        ],
      });
      done += 1;
      await save();
    }
  };
  try {
    await Promise.all(Array.from({ length: options.parallel ?? 3 }, worker));
    await saving;
    update(projectId, paperId, { running: false });
  } catch (reason) {
    cancelled = true;
    await saving.catch(() => {});
    update(projectId, paperId, {
      running: false,
      error: reason instanceof Error ? reason.message : String(reason),
    });
  } finally {
    entry(projectId, paperId).cancel = undefined;
  }
}
