import { createContext, useContext } from 'react';
import type { PageSummary } from '../model';
import type { Attached } from '../../../platform/attachments';
import type { LinkPreview } from '../../../platform/weblinks';

export type Pick = { path: string; title: string };
/** What the editor's blocks need from the rest of the app. */
export type DocEnv = {
  projectId: string;
  pageId: string;
  pages: PageSummary[];
  readOnly: boolean;
  openPage(id: string): void;
  openPaper(path: string): void;
  openFile(path: string): void;
  /** A stored image as a data URL. */
  loadImage(asset: string): Promise<string>;
  /** Stores an image and returns its path. */
  saveImage(file: File): Promise<string>;
  /** Attaches files of any kind: dropped or pasted ones, or chosen with the system dialog. */
  attachFiles(files: File[]): Promise<Attached[]>;
  pickAttachments(): Promise<Attached[]>;
  /** Shows an attachment in the center. */
  openAttachment(asset: string): void;
  /** A web page over the center; a page or block link (blockLink.ts) goes there instead. */
  openUrl(url: string): void;
  /** A short message at the top of the page, e.g. "已复制链接". */
  notify(message: string): void;
  /** A link card's contents. */
  previewLink(url: string): Promise<LinkPreview>;
  /** Makes a web page's main text a new subpage and opens it. */
  importLink(url: string): Promise<void>;
  paperNote(path: string): Promise<string>;
  /** Asks the person to choose a paper or a project file. */
  pick(kind: 'paper' | 'paperNote' | 'file'): Promise<Pick | null>;
  /** Creates a subpage of the open page and returns it. */
  createSubpage(): Promise<PageSummary | null>;
  userLabel(id: string): string;
  /** Members of a team project, for @. */
  members(): { id: string; label: string }[];
};
export const DocEnvContext = createContext<DocEnv | null>(null);
export function useDocEnv() {
  const env = useContext(DocEnvContext);
  if (!env) throw new Error('DocEnvContext missing');
  return env;
}
