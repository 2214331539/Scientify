import { t } from '../i18n';
import type { WebSources } from './workspace';

export function sourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(t('请输入完整的 HTTP 或 HTTPS 链接。'));
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.href.length > 2048
  )
    throw new Error(t('请输入不含账号密码的 HTTP 或 HTTPS 链接。'));
  return url.href;
}

/** Import/browser-storage boundary; malformed data is reported, never silently discarded. */
export function validateWebSources(value: unknown): asserts value is WebSources | undefined {
  if (value === undefined) return;
  const data = value as WebSources;
  const validId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
  const text = (s: unknown, max: number) => typeof s === 'string' && !!s.trim() && s.length <= max;
  const fail = () => {
    throw new Error(t('个人信息源数据无效，请检查导入文件。'));
  };
  if (
    !data ||
    !Array.isArray(data.groups) ||
    !Array.isArray(data.items) ||
    data.groups.length > 100 ||
    data.items.length > 2000
  )
    fail();
  const groups = new Set<string>();
  for (const g of data.groups) {
    if (
      !g ||
      !validId(g.id) ||
      groups.has(g.id) ||
      !text(g.name, 200) ||
      !Number.isSafeInteger(g.order) ||
      g.order < 0
    )
      fail();
    groups.add(g.id);
  }
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const item of data.items) {
    if (
      !item ||
      !validId(item.id) ||
      ids.has(item.id) ||
      !text(item.title, 200) ||
      !text(item.url, 2048) ||
      !Number.isSafeInteger(item.order) ||
      item.order < 0 ||
      (item.groupId !== undefined && !groups.has(item.groupId)) ||
      !text(item.createdAt, 100) ||
      !text(item.updatedAt, 100)
    )
      fail();
    const url = sourceUrl(item.url);
    if (urls.has(url)) fail();
    ids.add(item.id);
    urls.add(url);
  }
}
