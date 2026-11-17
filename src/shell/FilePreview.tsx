import { useEffect, useState } from 'react';
import { ExternalLink, FileText, X } from 'lucide-react';
import { Button } from '../components/primitives';
import { t, translateError } from '../i18n';
import { errorMessage } from '../domain/errors';
import { nativeResearch, openWithSystem } from '../platform/research';
import { browserCommand, type BrowserTab } from '../platform/browser-pane';
import { displayPath } from '../platform/os';
import { BinaryView, NotebookView, TableView, fileKind } from '../workspaces/files/viewers';
import MarkdownPreview from '../workspaces/files/MarkdownPreview';
import { BrowserPane } from '../workspaces/literature/BrowserPane';
import { DocxView, PptxView } from './OfficeViews';
import '../workspaces/files/files.css';
import './web-preview.css';

/** A file in one of the project's folders: `root` is the folder, `path` inside it. */
export type FilePreviewTarget = { projectId: string; root: string; path: string };

const HTML = /\.html?$/i;
const MARKDOWN = /\.(md|markdown)$/i;
const OFFICE = /\.(docx|pptx)$/i;
const OLD_OFFICE = /\.(doc|ppt|xls|xlsx)$/i;

/**
 * A file an AI answer points at, over the current module's center: HTML runs
 * in the built-in browser (charts and all), Word and PowerPoint render here,
 * and images, PDFs, tables, notebooks, Markdown and text show as they are.
 */
export function FilePreview({ target, onClose }: { target: FilePreviewTarget; onClose(): void }) {
  const { projectId, root, path } = target;
  const name = path.split('/').at(-1) ?? path;
  const kind = fileKind(path);
  const html = HTML.test(path);
  const office = OFFICE.test(path);
  const textual = !html && !office && (kind === 'table' || kind === 'notebook' || kind === 'text');
  const full = `${displayPath(root)}/${path}`;
  const [content, setContent] = useState<string | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [tab, setTab] = useState<BrowserTab | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  useEffect(() => {
    setContent(null);
    setBytes(null);
    setError('');
    let alive = true;
    const fail = (reason: unknown) => alive && setError(translateError(errorMessage(reason)));
    if (textual)
      nativeResearch
        .readFile(projectId, path, root)
        .then((file) => alive && setContent(file.content))
        .catch(fail);
    else if (office && nativeResearch.readBinary)
      nativeResearch
        .readBinary(projectId, path, root)
        .then((value) => alive && setBytes(value))
        .catch(fail);
    return () => {
      alive = false;
    };
  }, [projectId, root, path, textual, office]);
  // HTML gets a browser tab of its own, closed with the preview.
  useEffect(() => {
    if (!html) return;
    let alive = true;
    let opened = '';
    void browserCommand<BrowserTab>({ op: 'openFile', project_id: projectId, path: full })
      .then((value) => {
        opened = value.id;
        if (alive) setTab(value);
        else void browserCommand({ op: 'close', id: value.id }).catch(() => {});
      })
      .catch((reason) => alive && setError(translateError(errorMessage(reason))));
    return () => {
      alive = false;
      setTab(null);
      if (opened) void browserCommand({ op: 'close', id: opened }).catch(() => {});
    };
  }, [html, projectId, full]);
  const openOutside = () =>
    void openWithSystem(projectId, full).catch((reason) =>
      setError(translateError(errorMessage(reason))),
    );
  return (
    <section className="sf-web-preview" aria-label={t('文件预览')}>
      <header className="sf-web-preview-head">
        <FileText size={14} aria-hidden="true" />
        <span className="sf-web-preview-title" title={full}>
          {name}
        </span>
        <Button size="sm" variant="ghost" onClick={openOutside}>
          <ExternalLink size={14} aria-hidden="true" />
          {t('用系统程序打开')}
        </Button>
        <Button variant="ghost" iconOnly aria-label={t('关闭预览')} onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className={`sf-web-preview-body${html ? '' : ' sf-file-preview'}`}>
        {error ? (
          <p role="alert" className="error-text sf-file-loading">
            {error}
          </p>
        ) : html ? (
          tab ? (
            <BrowserPane key={tab.id} id={tab.id} initialUrl={tab.url} onChanged={() => {}} />
          ) : (
            <div className="sf-file-loading">{t('正在打开…')}</div>
          )
        ) : office ? (
          bytes === null ? (
            <div className="sf-file-loading">{t('正在读取…')}</div>
          ) : /\.docx$/i.test(path) ? (
            <DocxView bytes={bytes} />
          ) : (
            <PptxView bytes={bytes} />
          )
        ) : OLD_OFFICE.test(path) ? (
          <div className="sf-file-loading">
            <p>{t('这种格式不能在应用里预览。')}</p>
            <Button variant="primary" onClick={openOutside}>
              {t('用系统程序打开')}
            </Button>
          </div>
        ) : !textual ? (
          <BinaryView
            backend={nativeResearch}
            projectId={projectId}
            path={path}
            workspaceRoot={root}
            onContext={() => {}}
          />
        ) : content === null ? (
          <div className="sf-file-loading">{t('正在读取…')}</div>
        ) : kind === 'table' ? (
          <TableView content={content} path={path} />
        ) : kind === 'notebook' ? (
          <NotebookView content={content} />
        ) : MARKDOWN.test(path) ? (
          <MarkdownPreview content={content} />
        ) : (
          <pre className="sf-file-text">{content}</pre>
        )}
      </div>
    </section>
  );
}
