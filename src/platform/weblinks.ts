import { invoke } from '@tauri-apps/api/core';

/** What a link card shows: the page's title, summary, site, icon and cover picture. */
export type LinkPreview = {
  url: string;
  title: string;
  description: string;
  site: string;
  icon: string | null;
  image: string | null;
};

export const linkPreview = (url: string) => invoke<LinkPreview>('web_link_preview', { url });

/** A web page's main text as Markdown, for a new document. */
export const linkImport = (url: string) =>
  invoke<{ url: string; title: string; markdown: string }>('web_link_import', { url });
