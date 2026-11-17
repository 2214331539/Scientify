import { useEffect, useState } from 'react';
import { ExternalLink, FileText, X } from 'lucide-react';
import { Button } from '../components/primitives';
import { t, translateError } from '../i18n';
import { errorMessage } from '../domain/errors';
import { nativeResearch, openWithSystem } from '../platform/research';
import { displayPath } from '../platform/os';
import { BinaryView, NotebookView, TableView, fileKind } from '../workspaces/files/viewers';
import MarkdownPreview from '../workspaces/files/MarkdownPreview';
import '../workspaces/files/files.css';
import './web-preview.css';

/** A file in one of the project's folders: `root` is the folder, `path` inside it. */
export type FilePreviewTarget = { projectId: string; root: string; path: string };

const HTML = /\.html?$/i;
const MARKDOWN = /\.(md|markdown)$/i;

/**
 * A file an AI answer points at, over the current module's center: images,
 * PDFs, tables, notebooks, Markdown and text show here; HTML opens in the
 * system browser, where its scripts can run.
 */
export function FilePreview({ target, onClose }: { target: FilePreviewTarget; onClose(): void }) {
  const { projectId, root, path } = target;
  const name = path.split('/').at(-1) ?? path;
  const kind = fileKind(path);
  const textual = kind === 'table' || kind === 'notebook' || kind === 'text';
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');
  const full = `${displayPath(root)}/${path}`;
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  useEffect(() => {
    setContent(null);
    setError('');
    if (!textual || HTML.test(path)) return;
    let alive = true;
    nativeResearch
      .readFile(projectId, path, root)
      .then((file) => alive && setContent(file.content))
      .catch((reason) => alive && setError(translateError(errorMessage(reason))));
    return () => {
      alive = false;
    };
  }, [projectId, root, path, textual]);
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
      <div className="sf-web-preview-body sf-file-preview">
        {error ? (
          <p role="alert" className="error-text">
            {error}
          </p>
        ) : HTML.test(path) ? (
          <div className="sf-file-loading">
            <p>{t('网页文件在浏览器里打开，图表和交互才能正常显示。')}</p>
            <Button variant="primary" onClick={openOutside}>
              {t('在浏览器中打开')}
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
