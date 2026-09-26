import catalog from './messages.json';
import { getPreferences } from './preferences';

const messages: Record<string, string[]> = { ...catalog };
const singular: Record<string, string> = {
  '{count} 个项目': '{count} project',
  '{count} 篇文献': '{count} paper',
  '{count} 篇笔记': '{count} note',
  '{count} 行': '{count} line',
  '{count} 条 · 手动记录': '{count} record · Manual',
  '已选 {count} 字符': '{count} character selected',
  '{count} 个变更 · 状态来自项目 Git 仓库': '{count} change · From the project Git repository',
};
for (const entry of Object.values(catalog)) {
  messages[entry[0]] ??= entry;
  messages[entry[1]] ??= entry;
}
/** Only call for product-owned text, never for research content or file names. */
export function t(key: string, values: Record<string, string | number> = {}): string {
  const english = getPreferences().language === 'en';
  const translated =
    (english && values.count === 1 ? singular[key] : undefined) ??
    messages[key]?.[english ? 1 : 0] ??
    key;
  return translated.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match));
}
export const locale = () => (getPreferences().language === 'en' ? 'en-US' : 'zh-CN');

const errorPatterns = Object.entries(catalog)
  .filter(([key]) => /\{\w+\}/.test(key))
  .map(([key]) => {
    const names: string[] = [];
    const escaped = key
      .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
      .replace(/\{(\w+)\}/g, (_, name: string) => {
        names.push(name);
        return '(.+?)';
      });
    return { key, names, pattern: new RegExp(`^${escaped}$`, 's') };
  });
/** Localizes owned error messages while retaining technical details from external services. */
export function translateError(message: string | null | undefined) {
  if (!message) return '';
  if (messages[message]) return t(message);
  for (const { key, names, pattern } of errorPatterns) {
    const match = message.match(pattern);
    if (match)
      return t(key, Object.fromEntries(names.map((name, index) => [name, match[index + 1]])));
  }
  return message;
}
