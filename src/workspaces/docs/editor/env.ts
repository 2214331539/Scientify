import { createContext, useContext } from 'react';
import type { PageSummary } from '../model';

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
