import { t } from '../../i18n';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../../components/primitives';
import { mathRemarkPlugins, mathRehypePlugins, normalizeMathDelimiters } from './math';

const remarkPlugins = [remarkGfm, ...mathRemarkPlugins];

/** Untrusted Markdown never executes HTML or loads remote images. */
export function Markdown({
  children,
  onPage,
  onLink,
  notePreview = false,
}: {
  children: string;
  onPage?: (page: number) => void;
  onLink?: (url: string) => void;
  notePreview?: boolean;
}) {
  return (
    <div className="sf-markdown">
      <ReactMarkdown
        urlTransform={
          onPage || notePreview
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
          img: ({ alt, src }) =>
            notePreview ? (
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
            ),
          a: ({ children: label, href }) =>
            onPage && !notePreview && /^scientify-page:\d+$/.test(href ?? '') ? (
              <Button variant="ghost" onClick={() => onPage(Number(href!.split(':')[1]))}>
                {label}
              </Button>
            ) : (
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
            ),
        }}
      >
        {notePreview ? children : normalizeMathDelimiters(children)}
      </ReactMarkdown>
    </div>
  );
}
