/**
 * The AI's document tools run here, where pages are read and written in their own format: the
 * native side passes each call over (`docs-agent-request`) and waits for the answer.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { errorMessage } from '../../domain/errors';
import { nativeDocs, type DocsBackend } from '../../platform/docs';
import { cloudStore } from '../../features/projects/cloud';
import { markdownToBlocks, pageToMarkdown } from './markdown';
import { childrenOf, pathTo, type Block } from './model';
import { docsRuntime, setDocsUser } from './runtime';

type Operation = {
  op: 'replace' | 'insertAfter' | 'insertBefore' | 'delete' | 'append';
  block?: string;
  markdown?: string;
};
type Request = { id: string; projectId: string; tool: string; arguments: Record<string, unknown> };

const text = (value: unknown, name: string, limit = 2 * 1024 * 1024) => {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${name} 无效或过长。`);
  return value;
};

export async function runDocsTool(
  docs: DocsBackend,
  projectId: string,
  tool: string,
  args: Record<string, unknown>,
) {
  const runtime = docsRuntime(docs, projectId);
  await runtime.load(true);
  const pages = () => runtime.store.getState().pages;
  const linkTo = (title: string) => {
    const found = pages().find((item) => !item.deletedAt && item.title === title);
    return found ? { id: found.id, label: found.title } : undefined;
  };
  const live = (id: unknown) => {
    const found = pages().find((item) => item.id === id && !item.deletedAt);
    if (!found) throw new Error('页面不存在或已在回收站。');
    return found;
  };
  if (tool === 'scientify_list_docs') {
    const out: { id: string; title: string; path: string; updatedAt: string }[] = [];
    const walk = (parent: string | null) => {
      for (const item of childrenOf(pages(), parent)) {
        out.push({
          id: item.id,
          title: item.title,
          path: pathTo(pages(), item.id)
            .map((entry) => entry.title || '无标题')
            .join(' / '),
          updatedAt: item.updatedAt,
        });
        walk(item.id);
      }
    };
    walk(null);
    return { pages: out };
  }
  if (tool === 'scientify_read_doc') {
    const summary = live(args.id);
    // Unsaved edits on screen are saved first, so the AI reads what the person sees.
    await runtime.save(summary.id);
    const { page, version } = await docs.read(projectId, summary.id);
    const markdown = pageToMarkdown(page.title, page.blocks, { ids: true });
    if (markdown.length > 256 * 1024) throw new Error('页面过长，请让用户指出要处理的部分。');
    return { id: page.id, title: page.title, version, markdown };
  }
  if (tool === 'scientify_create_doc') {
    const title = text(args.title, '标题', 1000).trim();
    const parent = args.parent ? live(args.parent).id : null;
    const blocks = markdownToBlocks(text(args.markdown ?? '', '正文'), { page: linkTo });
    const created = await runtime.create({
      parent,
      title,
      blocks: blocks.length ? blocks : undefined,
    });
    return {
      id: created.id,
      version: runtime.store.getState().open[created.id]?.version,
      saved: true,
    };
  }
  if (tool === 'scientify_update_doc') {
    const summary = live(args.id);
    await runtime.save(summary.id);
    const { page, version } = await docs.read(projectId, summary.id);
    if (args.expectedVersion !== version) throw new Error('页面已修改，请重新读取后再编辑。');
    let blocks: Block[] = [...page.blocks];
    const at = (id: unknown) => {
      const index = blocks.findIndex((block) => block.id === id);
      if (index < 0) throw new Error(`找不到块 ${String(id)}。`);
      return index;
    };
    const parsed = (markdown: unknown) =>
      markdownToBlocks(text(markdown ?? '', 'Markdown'), { page: linkTo });
    const operations = Array.isArray(args.operations) ? (args.operations as Operation[]) : [];
    if (operations.length > 200) throw new Error('一次修改的操作太多。');
    for (const operation of operations) {
      if (operation.op === 'append') blocks = [...blocks, ...parsed(operation.markdown)];
      else if (operation.op === 'delete') blocks.splice(at(operation.block), 1);
      else if (operation.op === 'replace')
        blocks.splice(at(operation.block), 1, ...parsed(operation.markdown));
      else if (operation.op === 'insertAfter')
        blocks.splice(at(operation.block) + 1, 0, ...parsed(operation.markdown));
      else if (operation.op === 'insertBefore')
        blocks.splice(at(operation.block), 0, ...parsed(operation.markdown));
      else throw new Error(`未知的操作：${String((operation as Operation).op)}`);
    }
    const title = typeof args.title === 'string' ? args.title.trim() : page.title;
    if (runtime.store.getState().open[summary.id]) {
      runtime.edit(summary.id, { title, blocks }, true);
      await runtime.save(summary.id);
    } else {
      const next = { ...page, title, blocks, updatedAt: new Date().toISOString() };
      await docs.write(projectId, next, version);
      await runtime.load(true);
    }
    const after = await docs.read(projectId, summary.id);
    return { id: summary.id, version: after.version, saved: true };
  }
  throw new Error('未知的文档操作。');
}

/** Answers the native side's document tool calls; started once by the app. */
export function listenDocsAgent(docs: DocsBackend = nativeDocs) {
  setDocsUser(() => cloudStore.getState().state?.userId ?? undefined);
  if (!isTauri()) return () => {};
  const stop = listen<Request>('docs-agent-request', async ({ payload }) => {
    let ok = true;
    let value: unknown;
    try {
      value = await runDocsTool(docs, payload.projectId, payload.tool, payload.arguments ?? {});
    } catch (reason) {
      ok = false;
      value = errorMessage(reason);
    }
    await invoke('docs_agent_respond', { id: payload.id, ok, value: value ?? null }).catch(
      () => {},
    );
  });
  return () => void stop.then((unlisten) => unlisten());
}
