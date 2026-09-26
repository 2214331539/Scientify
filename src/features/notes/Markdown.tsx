import { t } from '../../i18n';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Untrusted Markdown never executes HTML or loads remote images. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="sf-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ alt }) => (
            <span className="sf-muted">{t('[图片：{alt}]', { alt: alt || t('未命名图片') })}</span>
          ),
          a: ({ children: label, href }) => (
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
