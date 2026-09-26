import { t } from '../../i18n';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../../components/primitives';

/** Untrusted Markdown never executes HTML or loads remote images. */
export function Markdown({
  children,
  onPage,
}: {
  children: string;
  onPage?: (page: number) => void;
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
        remarkPlugins={[remarkGfm]}
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
              <a href={href} target="_blank" rel="noreferrer">
                {label}
              </a>
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
