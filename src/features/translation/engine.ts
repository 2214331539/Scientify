import { t } from '../../i18n';
import { collaboration } from '../../platform/collaboration';
import type { LibraryPaper } from '../../platform/library';
import type { TranslationModel, Translator } from '../../platform/translator';
import type { WorkspaceStore } from '../../stores/workspace';
import { loadConnectionKey } from '../assistant/connections';
import type { AISettings } from '../assistant/model';

const AUTO_KEY = 'scientify.translate.auto';
const seenKey = (projectId: string) => `scientify.translate.seen.${projectId}`;
/** More new papers than this at once (an import) are translated on request. */
export const AUTO_LIMIT = 5;

/**
 * The assistant's model, for the translation engine to call. A ChatGPT sign-in only
 * drives the Agent, so translation then uses another saved connection, the official
 * model first.
 */
export async function translationModel(store: WorkspaceStore): Promise<TranslationModel> {
  const data = store.getState().data;
  let settings = data?.settings.model as AISettings | undefined;
  if (settings?.provider === 'chatgpt') {
    const others = (data?.settings.modelProfiles ?? []).filter(
      (profile) => profile.provider !== 'chatgpt' && profile.model,
    );
    settings = others.find((profile) => profile.serviceId === 'scientify') ?? others[0];
    if (!settings)
      throw new Error(
        t('ChatGPT 账号只用于 AI 助手。全文翻译需要另一个模型，请在模型设置里再添加一个。'),
      );
  }
  if (!settings?.model) throw new Error(t('请先在设置里选好 AI 模型。'));
  const apiKey = await loadConnectionKey(settings);
  const endpoint =
    settings.serviceId === 'scientify'
      ? (await collaboration.status()).endpoint
      : settings.endpoint;
  return { provider: settings.provider, endpoint, model: settings.model, apiKey };
}

/** Whether papers that arrive are translated by themselves (on unless turned off). */
export function autoTranslate() {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'off';
  } catch {
    return true;
  }
}
export function setAutoTranslate(on: boolean) {
  try {
    localStorage.setItem(AUTO_KEY, on ? 'on' : 'off');
  } catch {
    /* A preference that cannot be kept stays on. */
  }
}

/**
 * The PDFs (by path in the literature folder) that arrived since this project was
 * last seen. The first look only remembers what is there, so the feature never
 * translates a whole existing library.
 */
export function arrivedPdfs(projectId: string, paths: string[]) {
  let seen: Set<string> | null = null;
  try {
    const stored = localStorage.getItem(seenKey(projectId));
    if (stored) seen = new Set(JSON.parse(stored) as string[]);
  } catch {
    seen = null;
  }
  const fresh = seen ? paths.filter((path) => !seen.has(path)) : [];
  const all = new Set([...(seen ?? []), ...paths]);
  try {
    localStorage.setItem(seenKey(projectId), JSON.stringify([...all].slice(-5000)));
  } catch {
    /* Without memory, nothing counts as new. */
  }
  return fresh;
}

/**
 * Translates PDFs that just arrived (downloaded, dropped in, synced), once each, in
 * the background. `open` registers a PDF as a paper; a paper translated before (the
 * same file moved or renamed) is not translated again.
 */
export async function translateArrivals(
  projectId: string,
  paths: string[],
  open: (path: string) => Promise<LibraryPaper>,
  store: WorkspaceStore,
  engine: Translator,
) {
  const fresh = arrivedPdfs(projectId, paths);
  if (!fresh.length || fresh.length > AUTO_LIMIT || !autoTranslate()) return;
  const model = await translationModel(store);
  for (const path of fresh) {
    const paper = await open(path);
    await engine.request(projectId, paper.id, model);
  }
}
