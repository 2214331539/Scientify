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
}: {
  children: string;
  onPage?: (page: number) => void;
  onLink?: (url: string) => void;
}) {
  return (
    <div className="sf-markdown">
      <ReactMarkdown
        urlTransform={
          onPage
            ? (url) =>
                /^scientify-page:\d+$/.test(url)
                  ? url
                  : /^(https?:|mailto:|\/|#)/i.test(url)
                    ? url
                    : ''
            : undefined
        }
        remarkPlugins={remarkPlugins}
        rehypePlugins={mathRehypePlugins}
        components={{
          img: ({ alt }) => (
            <span className="sf-muted">{t('[图片：{alt}]', { alt: alt || t('未命名图片') })}</span>
          ),
          a: ({ children: label, href }) =>
            onPage && /^scientify-page:\d+$/.test(href ?? '') ? (
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
        {normalizeMathDelimiters(children)}
      </ReactMarkdown>
    </div>
  );
}
