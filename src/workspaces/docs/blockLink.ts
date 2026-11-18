// Links to a page or one block in it, as Feishu's "复制链接":
// scientify://docs/<project>/<page>#<block>. Opening one goes to the page and
// brings the block into view.

export type DocTarget = { projectId: string; pageId: string; blockId?: string };

const PATTERN = /^scientify:\/\/docs\/([\w-]+)\/([\w-]+)(?:#([\w-]+))?$/;

export const blockLink = ({ projectId, pageId, blockId }: DocTarget) =>
  `scientify://docs/${projectId}/${pageId}${blockId ? `#${blockId}` : ''}`;

export function parseBlockLink(href: string): DocTarget | null {
  const match = PATTERN.exec(href.trim());
  if (!match) return null;
  return { projectId: match[1], pageId: match[2], ...(match[3] ? { blockId: match[3] } : {}) };
}

// The block to show once its page has opened.
let pending: { pageId: string; blockId: string } | null = null;

/** Goes to a linked page; the page brings the block into view when it opens. */
export function openDocTarget(target: DocTarget, open: { projectId: string; pageId: string }) {
  if (target.blockId && target.projectId === open.projectId && target.pageId === open.pageId)
    return void revealBlock(target.blockId);
  pending = target.blockId ? { pageId: target.pageId, blockId: target.blockId } : null;
  window.dispatchEvent(
    new CustomEvent('scientify-open-source', {
      detail: {
        projectId: target.projectId,
        workspace: 'notes',
        resourceId: target.pageId,
        title: '',
      },
    }),
  );
}

/** The block a link asked to show on this page, once. */
export function takePendingBlock(pageId: string) {
  if (pending?.pageId !== pageId) return null;
  const { blockId } = pending;
  pending = null;
  return blockId;
}

/** Scrolls a block into view and marks it for a moment; false when it isn't on the page. */
export function revealBlock(blockId: string) {
  const element = document.querySelector<HTMLElement>(
    `.doc-editor [data-id="${CSS.escape(blockId)}"]`,
  );
  if (!element) return false;
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  element.classList.add('is-linked');
  setTimeout(() => element.classList.remove('is-linked'), 1800);
  return true;
}
