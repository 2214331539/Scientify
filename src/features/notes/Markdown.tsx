import { t } from '../../i18n';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../../components/primitives';
import { CodeBlock, hastText } from '../../components/ai/CodeBlock';
import { LocalImage } from '../../components/ai/LocalImage';
import { FileChip } from '../../components/ai/FileChip';
import { Children, isValidElement, type ReactNode } from 'react';

/** The text inside a link's children. */
function plainText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? plainText(child.props.children)
          : '',
    )
    .join('');
}
import { mathRemarkPlugins, mathRehypePlugins, normalizeMathDelimiters } from './math';
import { openDocTarget, parseBlockLink } from '../../workspaces/docs/blockLink';

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
            ? (url) =>
                /^(https?:|mailto:|#)/i.test(url) || LOCAL.test(url) || parseBlockLink(url)
                  ? url
                  : ''
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
                  const text = hastText(code).replace(/\n$/, '');
                  // A block holding nothing but a file path is a file, not code.
                  const path = !text.includes('\n') ? localPath(text.trim()) : null;
                  if (path && PATH_CODE.test(path.replace(/^\\\\\?\\/, '')))
                    return (
                      <p>
                        <FileChip path={path} onOpen={onOpenFile} />
                      </p>
                    );
                  return <CodeBlock code={text} language={language} />;
                },
                code: ({ children: text, className }) => {
                  const value = typeof text === 'string' ? text.trim() : '';
                  const path = !className ? localPath(value) : null;
                  return path && PATH_CODE.test(path.replace(/^\\\\\?\\/, '')) ? (
                    <FileChip path={path} onOpen={onOpenFile} />
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
            // A local file shows as its name with an icon, never as a raw path.
            if (path) return <FileChip path={path} label={plainText(label)} onOpen={onOpenFile} />;
            // A project document (blockLink.ts) opens in the documents module.
            const doc = rich && href ? parseBlockLink(href) : null;
            if (doc)
              return (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    openDocTarget(doc, { projectId: '', pageId: '' });
                  }}
                >
                  {label}
                </a>
              );
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={
                  onLink && /^https?:\/\//i.test(href ?? '')
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
