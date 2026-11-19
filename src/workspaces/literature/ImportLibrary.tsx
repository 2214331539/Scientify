import { useEffect, useMemo, useState } from 'react';
import { BookCopy, Check, ChevronLeft, FileCode2, FolderOpen, Library } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button, Input } from '../../components/primitives';
import { t, translateError } from '../../i18n';
import {
  nativeReferenceImport,
  type ImportKind,
  type ImportPreview,
  type ImportProgress,
  type ImportReport,
  type ReferenceImport,
} from '../../platform/reference-import';
import './import-library.css';

type Step =
  | { name: 'source' }
  | { name: 'reading' }
  | { name: 'preview'; preview: ImportPreview }
  | { name: 'running'; preview: ImportPreview }
  | { name: 'done'; report: ImportReport };

/**
 * Bring a Zotero library, or a BibTeX / RIS export, into the literature folder:
 * collections become folders, PDFs are copied once, notes and highlights come along.
 */
export function ImportLibrary({
  projectId,
  api = nativeReferenceImport,
  onClose,
  onDone,
}: {
  projectId: string;
  api?: ReferenceImport;
  onClose(): void;
  /** After an import that added something; the folder it went into. */
  onDone(report: ImportReport): void;
}) {
  const [step, setStep] = useState<Step>({ name: 'source' });
  const [zotero, setZotero] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [folder, setFolder] = useState('');
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  useEffect(() => {
    let live = true;
    void api
      .sources()
      .then((found) => live && setZotero(found.zotero))
      .catch(() => live && setZotero([]));
    return () => {
      live = false;
    };
  }, [api]);
  useEffect(() => {
    if (step.name !== 'running') return;
    let stop: (() => void) | undefined;
    let live = true;
    void api
      .progress((next) => live && setProgress(next))
      .then((unlisten) => {
        if (live) stop = unlisten;
        else unlisten();
      });
    return () => {
      live = false;
      stop?.();
    };
  }, [api, step.name]);

  async function read(kind: ImportKind, path?: string | null, pick = false) {
    setError('');
    try {
      const chosen = pick ? await api.pick(kind) : path;
      if (pick && !chosen) return;
      setStep({ name: 'reading' });
      const preview = await api.preview(kind, chosen);
      setSelected(new Set(['', ...preview.collections.map((c) => c.id)]));
      setFolder(preview.folder);
      setStep({ name: 'preview', preview });
    } catch (reason) {
      setError(String(reason));
      setStep({ name: 'source' });
    }
  }

  async function run(preview: ImportPreview) {
    setError('');
    setProgress({ done: 0, total: 0, title: '' });
    setStep({ name: 'running', preview });
    const all = selected.size === preview.collections.length + 1;
    try {
      const report = await api.run(projectId, preview.id, all ? null : [...selected], folder);
      setStep({ name: 'done', report });
      if (report.papers || report.notes || report.references) onDone(report);
    } catch (reason) {
      setError(String(reason));
      setStep({ name: 'preview', preview });
    }
  }

  const busy = step.name === 'reading' || step.name === 'running';
  return (
    <Modal title={t('导入文献库')} className="import-library" busy={busy} onClose={onClose}>
      {step.name === 'source' || step.name === 'reading' ? (
        <div className="import-sources">
          <button
            type="button"
            className="import-source"
            disabled={busy || zotero === null}
            onClick={() =>
              zotero?.length ? void read('zotero', zotero[0]) : void read('zotero', null, true)
            }
          >
            <Library />
            <strong>Zotero</strong>
            <span>
              {zotero === null
                ? t('正在查找…')
                : zotero.length
                  ? t('已找到 {path}', { path: zotero[0] })
                  : t('选择 Zotero 数据文件夹')}
            </span>
          </button>
          <button
            type="button"
            className="import-source"
            disabled={busy}
            onClick={() => void read('file', null, true)}
          >
            <FileCode2 />
            <strong>BibTeX / RIS</strong>
            <span>{t('Mendeley、EndNote、JabRef 等导出的 .bib 或 .ris')}</span>
          </button>
          {zotero?.length ? (
            <Button
              variant="ghost"
              className="import-other"
              disabled={busy}
              onClick={() => void read('zotero', null, true)}
            >
              <FolderOpen />
              {t('选择其他 Zotero 文件夹')}
            </Button>
          ) : null}
          {step.name === 'reading' ? (
            <p className="import-status" role="status">
              {t('正在读取…')}
            </p>
          ) : null}
        </div>
      ) : step.name === 'preview' ? (
        <PreviewStep
          preview={step.preview}
          selected={selected}
          onSelected={setSelected}
          folder={folder}
          onFolder={setFolder}
          onReread={() =>
            void read(step.preview.kind === 'zotero' ? 'zotero' : 'file', step.preview.location)
          }
        />
      ) : step.name === 'running' ? (
        <div className="import-running">
          <div
            className="import-bar"
            role="progressbar"
            aria-label={t('导入进度')}
            aria-valuemin={0}
            aria-valuemax={progress?.total || 1}
            aria-valuenow={progress?.done ?? 0}
          >
            <span
              style={{
                width: `${progress?.total ? (progress.done / progress.total) * 100 : 0}%`,
              }}
            />
          </div>
          <p role="status">
            {progress?.total
              ? t('正在导入 {done}/{total}', { done: progress.done, total: progress.total })
              : t('正在准备…')}
          </p>
          <p className="import-current">{progress?.title}</p>
        </div>
      ) : (
        <Summary report={step.report} />
      )}
      {error ? (
        <p role="alert" className="error-text">
          {translateError(error)}
        </p>
      ) : null}
      <footer className="dialog-footer">
        {step.name === 'preview' ? (
          <>
            <Button variant="ghost" onClick={() => setStep({ name: 'source' })}>
              <ChevronLeft />
              {t('返回')}
            </Button>
            <span className="spacer" />
            <Button
              variant="primary"
              disabled={!selected.size}
              onClick={() => void run(step.preview)}
            >
              {t('开始导入')}
            </Button>
          </>
        ) : step.name === 'running' ? (
          <>
            <span className="spacer" />
            <Button onClick={() => void api.cancel()}>{t('停止')}</Button>
          </>
        ) : step.name === 'done' ? (
          <>
            <span className="spacer" />
            <Button variant="primary" onClick={onClose}>
              {t('完成')}
            </Button>
          </>
        ) : null}
      </footer>
    </Modal>
  );
}

function PreviewStep({
  preview,
  selected,
  onSelected,
  folder,
  onFolder,
  onReread,
}: {
  preview: ImportPreview;
  selected: Set<string>;
  onSelected(next: Set<string>): void;
  folder: string;
  onFolder(next: string): void;
  onReread(): void;
}) {
  const children = useMemo(() => {
    const map = new Map<string | null, string[]>();
    for (const c of preview.collections) {
      const list = map.get(c.parent) ?? [];
      list.push(c.id);
      map.set(c.parent, list);
    }
    return map;
  }, [preview.collections]);
  const byId = useMemo(
    () => new Map(preview.collections.map((c) => [c.id, c])),
    [preview.collections],
  );
  const below = (id: string): string[] => [
    id,
    ...(children.get(id) ?? []).flatMap((child) => below(child)),
  ];
  const total = (id: string) =>
    below(id).reduce((sum, each) => sum + (byId.get(each)?.items ?? 0), 0);
  function toggle(ids: string[], on: boolean) {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    onSelected(next);
  }
  const everything = ['', ...preview.collections.map((c) => c.id)];
  const rows: { id: string; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const id of children.get(parent) ?? []) {
      rows.push({ id, depth });
      walk(id, depth + 1);
    }
  };
  walk(null, 0);
  const stats = [
    [t('条目'), preview.items],
    ['PDF', preview.pdfs],
    [t('笔记'), preview.notes],
    [t('高亮'), preview.highlights],
  ] as const;
  return (
    <div className="import-preview">
      <p className="import-location" title={preview.location}>
        {preview.kind === 'zotero' ? 'Zotero' : preview.kind === 'ris' ? 'RIS' : 'BibTeX'}
        <span>{preview.location}</span>
      </p>
      <dl className="import-stats">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {preview.fromBackup ? (
        <p className="import-note">
          {t('Zotero 正在运行，读到的是它最近一次的备份。')}
          <Button variant="ghost" onClick={onReread}>
            {t('关闭 Zotero 后重新读取')}
          </Button>
        </p>
      ) : null}
      {preview.withoutPdf ? (
        <p className="import-note">
          {t('{count} 条没有 PDF，只写入 references.bib', { count: preview.withoutPdf })}
        </p>
      ) : null}
      {preview.missing ? (
        <p className="import-note">
          {t('{count} 个 PDF 不在本机，可能还没从云端下载', { count: preview.missing })}
        </p>
      ) : null}
      {preview.warnings.map((warning) => (
        <p key={warning} className="import-note">
          {warning}
        </p>
      ))}
      {preview.collections.length ? (
        <fieldset className="import-collections">
          <legend>{t('分类')}</legend>
          <label className="import-collection">
            <input
              type="checkbox"
              checked={selected.size === everything.length}
              onChange={(e) => onSelected(e.target.checked ? new Set(everything) : new Set())}
            />
            <span>{t('全部')}</span>
            <em>{preview.collections.reduce((sum, c) => sum + c.items, 0) + preview.unfiled}</em>
          </label>
          {rows.map(({ id, depth }) => (
            <label
              key={id}
              className="import-collection"
              style={{ paddingInlineStart: 22 + depth * 18 }}
            >
              <input
                type="checkbox"
                checked={selected.has(id)}
                onChange={(e) => toggle(below(id), e.target.checked)}
              />
              <span>{byId.get(id)?.name}</span>
              <em>{total(id)}</em>
            </label>
          ))}
          {preview.unfiled ? (
            <label className="import-collection" style={{ paddingInlineStart: 22 }}>
              <input
                type="checkbox"
                checked={selected.has('')}
                onChange={(e) => toggle([''], e.target.checked)}
              />
              <span>{t('未分类')}</span>
              <em>{preview.unfiled}</em>
            </label>
          ) : null}
        </fieldset>
      ) : null}
      <label className="import-folder">
        {t('放到文献目录下的')}
        <Input
          value={folder}
          aria-label={t('目标文件夹')}
          placeholder={t('文献目录根部')}
          onChange={(e) => onFolder(e.target.value)}
        />
      </label>
    </div>
  );
}

function Summary({ report }: { report: ImportReport }) {
  const lines = [
    [t('新增论文'), report.papers],
    [t('已在文献库，未重复复制'), report.duplicates],
    [t('高亮'), report.highlights],
    [t('笔记'), report.notes],
    [t('写入 references.bib'), report.references],
  ] as const;
  return (
    <div className="import-done">
      <p className="import-done-title">
        <Check />
        {report.cancelled ? t('已停止，已导入的内容保留') : t('导入完成')}
      </p>
      <dl className="import-summary">
        {lines
          .filter(([, value]) => value > 0)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {report.folder ? (
        <p className="import-location">
          <BookCopy />
          <span>{report.folder}</span>
        </p>
      ) : null}
      {report.failed.length ? (
        <details className="import-failed">
          <summary>{t('{count} 条没有导入', { count: report.failed.length })}</summary>
          <ul>
            {report.failed.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
