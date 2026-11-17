import { t } from '../../i18n';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../../components/primitives';
import { CodeBlock, hastText } from '../../components/ai/CodeBlock';
import { LocalImage } from '../../components/ai/LocalImage';
import { mathRemarkPlugins, mathRehypePlugins, normalizeMathDelimiters } from './math';

const remarkPlugins = [remarkGfm, ...mathRemarkPlugins];

/** A file on this computer, as answers write it: `C:\…`, `\\?\…`, `/…` or `file:///…`. */
const LOCAL = /^(?:file:\/\/\/?|[a-z]:[\\/]|\\\\\?\\|\/(?!\/))/i;
/** An absolute path to a file written as inline code, e.g. `C:\work\report.png`. */
const PATH_CODE = /^(?:[a-z]:[\\/]|\/(?!\/))[^\n*?"<>|]*\.[a-z0-9]{1,8}$/i;

/** The path a local link or image source names. */
export function localPath(url: string) {
  if (!LOCAL.test(url)) return null;
  let path = url.replace(/^file:\/\/\/?/i, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    /* Keep it as written. */
  }
  // file:///C:/x → C:/x; file:///home/x → /home/x
  return /^[a-z]:/i.test(path) || path.startsWith('\\\\') ? path : `/${path.replace(/^\/+/, '')}`;
}

/**
 * Untrusted Markdown never executes HTML or loads remote images. `rich` answers
 * (the assistant's) also highlight code with a copy button, show local images
 * through `loadImage` and open local files through `onOpenFile`.
 */
export function Markdown({
  children,
  onPage,
  onLink,
  onOpenFile,
  loadImage,
  rich = false,
  notePreview = false,
}: {
  children: string;
  onPage?: (page: number) => void;
  onLink?: (url: string) => void;
  onOpenFile?: (path: string) => void;
  loadImage?: (path: string) => Promise<Blob | null>;
  rich?: boolean;
  notePreview?: boolean;
}) {
  return (
    <div className="sf-markdown">
      <ReactMarkdown
        urlTransform={
          rich
            ? (url) => (/^(https?:|mailto:|#)/i.test(url) || LOCAL.test(url) ? url : '')
            : onPage || notePreview
              ? (url, key) =>
                  notePreview && key === 'src' && !/^(?:[a-z][\w+.-]*:|[\\/])/i.test(url)
                    ? url
                    : /^scientify-page:\d+$/.test(url)
                      ? url
                      : /^(https?:|mailto:|\/|#)/i.test(url)
                        ? url
                        : ''
              : undefined
        }
        remarkPlugins={remarkPlugins}
        rehypePlugins={mathRehypePlugins}
        components={{
          ...(rich
            ? {
                pre: ({ node }) => {
                  const code = node?.children?.[0] as Parameters<typeof hastText>[0] & {
                    properties?: { className?: unknown };
                  };
                  const classes = Array.isArray(code?.properties?.className)
                    ? (code.properties.className as string[])
                    : [];
                  const language = classes
                    .map(String)
                    .find((name) => name.startsWith('language-'))
                    ?.slice('language-'.length);
                  return <CodeBlock code={hastText(code).replace(/\n$/, '')} language={language} />;
                },
                code: ({ children: text, className }) => {
                  const value = typeof text === 'string' ? text : '';
                  return onOpenFile && !className && PATH_CODE.test(value) ? (
                    <button
                      type="button"
                      className="sf-path-link"
                      onClick={() => onOpenFile(value)}
                    >
                      <code>{value}</code>
                    </button>
                  ) : (
                    <code className={className}>{text}</code>
                  );
                },
              }
            : {}),
          img: ({ alt, src }) => {
            const path = rich && typeof src === 'string' ? localPath(src) : null;
            if (path && loadImage)
              return <LocalImage src={path} alt={alt} load={loadImage} onOpen={onOpenFile} />;
            return notePreview ? (
              <span
                className="sf-note-image"
                data-note-image={src}
                role="img"
                aria-label={alt || t('未命名图片')}
              >
                {t('[图片：{alt}]', { alt: alt || t('未命名图片') })}
              </span>
            ) : (
              <span className="sf-muted">
                {t('[图片：{alt}]', { alt: alt || t('未命名图片') })}
              </span>
            );
          },
          a: ({ children: label, href }) => {
            if (onPage && !notePreview && /^scientify-page:\d+$/.test(href ?? ''))
              return (
                <Button variant="ghost" onClick={() => onPage(Number(href!.split(':')[1]))}>
                  {label}
                </Button>
              );
            const path = rich && href ? localPath(href) : null;
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={
                  path && onOpenFile
                    ? (event) => {
                        event.preventDefault();
                        onOpenFile(path);
                      }
                    : onLink && /^https?:\/\//i.test(href ?? '')
                      ? (event) => {
                          event.preventDefault();
                          onLink(href!);
                        }
                      : undefined
                }
              >
                {label}
              </a>
            );
          },
        }}
      >
        {notePreview ? children : normalizeMathDelimiters(children)}
      </ReactMarkdown>
    </div>
  );
}
