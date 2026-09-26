import { t } from '../../i18n';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function MarkdownPreview({ content }: { content: string }) {
  return (
    <article className="sf-markdown-preview" aria-label={t('Markdown 预览')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ alt }) => (
            <span className="sf-markdown-image">
              {t('[图片：{alt} · 外部图片不自动加载]', { alt: alt || t('未命名') })}
            </span>
          ),
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content || t('*尚无内容*')}
      </ReactMarkdown>
    </article>
  );
}
