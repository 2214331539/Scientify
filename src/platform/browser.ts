import { t } from '../i18n';
import type { WorkspaceBackend } from './desktop';
import type { FileContent, ResearchBackend, ResearchFile } from './research';
import { emptyWorkspace, normalizeExperiments, type Workspace } from '../domain/workspace';

const DATA_KEY = 'scientify.mvp.preview.workspace.v1';
const FILE_KEY = 'scientify.mvp.preview.files.v1';
function readWorkspace(): Workspace | null {
  const raw = localStorage.getItem(DATA_KEY);
  if (!raw) return null;
  return parseWorkspace(raw);
}
function parseWorkspace(raw: string): Workspace {
  const value = JSON.parse(raw) as Workspace;
  if (
    !value ||
    value.schema !== 3 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    Object.entries(emptyWorkspace()).some(
      ([key, entry]) => key !== 'experiments' && Array.isArray(entry) && !Array.isArray(value[key]),
    ) ||
    !value.settings ||
    typeof value.settings !== 'object' ||
    !value.settings.model
  )
    throw new Error(t('浏览器预览数据无法读取，请先导出浏览器存储进行恢复。'));
  return normalizeExperiments(value);
}
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}
export const browserWorkspace: WorkspaceBackend = {
  load: async () => ({
    workspace: readWorkspace(),
    directory: t('浏览器独立预览存储（与桌面数据隔离）'),
    legacyAvailable: false,
  }),
  save: async (value, revision) => {
    if ((readWorkspace()?.revision ?? 0) !== revision)
      throw new Error(t('预览数据已在其他标签页更新，请保留草稿后重新载入。'));
    const previous = localStorage.getItem(DATA_KEY);
    if (previous) localStorage.setItem(`${DATA_KEY}.backup`, previous);
    localStorage.setItem(DATA_KEY, JSON.stringify(value));
    return structuredClone(value);
  },
  restore: async () => {
    const previous = localStorage.getItem(`${DATA_KEY}.backup`);
    if (!previous) throw new Error(t('暂无可恢复的预览备份。'));
    const next = parseWorkspace(previous);
    const current = localStorage.getItem(DATA_KEY);
    let revision = next.revision;
    try {
      revision = Math.max(revision, readWorkspace()?.revision ?? 0);
    } catch {
      // Recovery must work even when the main snapshot cannot be parsed.
    }
    if (revision >= Number.MAX_SAFE_INTEGER) throw new Error(t('工作区版本超过上限。'));
    next.revision = revision + 1;
    next.updatedAt = new Date().toISOString();
    if (current) localStorage.setItem(`${DATA_KEY}.before-restore.${crypto.randomUUID()}`, current);
    localStorage.setItem(DATA_KEY, JSON.stringify(next));
    return next;
  },
  migrateLegacy: async () => {
    throw new Error(t('复制旧数据需要在桌面应用中完成。'));
  },
  importWorkspace: async () => {
    throw new Error(t('为避免附件路径混用，请在桌面应用中导入工作区。'));
  },
  exportWorkspace: async () => {
    download(
      JSON.stringify(readWorkspace() ?? emptyWorkspace(), null, 2),
      'scientify-preview.json',
    );
    return true;
  },
  chooseDirectory: async () => {
    throw new Error(t('关联本地目录请使用桌面应用；预览中的文件使用浏览器独立存储。'));
  },
};

type BrowserFiles = Record<string, Record<string, FileContent>>;
const readFiles = (): BrowserFiles => JSON.parse(localStorage.getItem(FILE_KEY) ?? '{}');
function ownEntry<T>(entries: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(entries, key) ? entries[key] : undefined;
}
function checkPath(path: string) {
  if (
    !path ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.split('/').some((p) => !p || p === '.' || p === '..' || /[:\x00-\x1f]/.test(p))
  )
    throw new Error(t('请使用项目内的相对文件路径。'));
}
async function assets<T>(operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('scientify-mvp-preview', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('assets');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction('assets', 'readwrite');
      const request = operation(transaction.objectStore('assets'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error(t('附件写入被取消。')));
    });
  } finally {
    database.close();
  }
}
export const browserResearch: ResearchBackend = {
  listFiles: async (projectId) => {
    const entries = Object.values(ownEntry(readFiles(), projectId) ?? {});
    const folders = new Set<string>();
    entries.forEach((f) => {
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    });
    return [
      ...Array.from(folders, (path) => ({
        path,
        name: path.split('/').at(-1)!,
        kind: 'directory',
        size: 0,
      })),
      ...entries.map((f) => ({
        path: f.path,
        name: f.path.split('/').at(-1)!,
        kind: 'file',
        size: new TextEncoder().encode(f.content).length,
      })),
    ] as ResearchFile[];
  },
  readFile: async (projectId, path) => {
    const entry = ownEntry(ownEntry(readFiles(), projectId) ?? {}, path);
    if (!entry) throw new Error(t('文件不存在。'));
    return entry;
  },
  writeFile: async (projectId, path, content, expectedVersion) => {
    checkPath(path);
    if (new TextEncoder().encode(content).length > 2 * 1024 * 1024)
      throw new Error(t('文本文件超过 2 MiB。'));
    const files = readFiles();
    const projectFiles = ownEntry(files, projectId) ?? {};
    const previous = ownEntry(projectFiles, path);
    if ((previous?.version ?? null) !== expectedVersion)
      throw new Error(t('文件已修改，请保留草稿后重新读取，不会覆盖现有文件。'));
    const next = { path, content, version: crypto.randomUUID() };
    // Computed properties preserve valid names such as __proto__ as actual files.
    const nextFiles = { ...files, [projectId]: { ...projectFiles, [path]: next } };
    localStorage.setItem(FILE_KEY, JSON.stringify(nextFiles));
    return next;
  },
  importPdf: async () => {
    const file = await pickFile('.pdf,application/pdf');
    if (!file) return null;
    if (file.size > 25 * 1024 * 1024) throw new Error(t('首版支持 25 MiB 以内的 PDF。'));
    const bytes = await file.arrayBuffer();
    if (!new TextDecoder().decode(bytes.slice(0, 5)).startsWith('%PDF-'))
      throw new Error(t('所选文件不是可识别的 PDF。'));
    const assetId = crypto.randomUUID();
    await assets((store) => store.put(bytes, assetId));
    return { assetId, fileName: file.name, size: file.size };
  },
  readPdf: async (assetId) => {
    const bytes = await assets((store) => store.get(assetId));
    if (!(bytes instanceof ArrayBuffer)) throw new Error(t('预览附件不存在，请重新导入 PDF。'));
    return new Uint8Array(bytes);
  },
  gitStatus: async () => {
    throw new Error(t('Git 状态需要关联本地仓库，请在桌面应用中使用。'));
  },
  askAI: async () => {
    throw new Error(t('AI 请求通过桌面后端发送。请启动桌面应用并配置模型。'));
  },
  listModels: async () => {
    throw new Error(t('AI 请求通过桌面后端发送。请启动桌面应用并配置模型。'));
  },
  testModel: async () => {
    throw new Error(t('AI 请求通过桌面后端发送。请启动桌面应用并配置模型。'));
  },
  fetchArxiv: async () => {
    throw new Error(t('订阅更新通过桌面后端获取，请在桌面应用中更新。'));
  },
};
