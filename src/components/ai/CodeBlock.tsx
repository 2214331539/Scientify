import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { common, createLowlight } from 'lowlight';
import { t } from '../../i18n';

const lowlight = createLowlight(common);
// Highlighting a huge block costs more than it helps.
const HIGHLIGHT_LIMIT = 40_000;

type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
};

function render(nodes: HastNode[] | undefined, key = 'n'): ReactNode[] {
  return (nodes ?? []).map((node, index) => {
    if (node.type === 'text') return node.value ?? '';
    if (node.type !== 'element') return null;
    const className = Array.isArray(node.properties?.className)
      ? node.properties.className.join(' ')
      : undefined;
    return (
      <span key={`${key}.${index}`} className={className}>
        {render(node.children, `${key}.${index}`)}
      </span>
    );
  });
}

/** A fenced code block in an answer: highlighted, with its language and a copy button. */
export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const highlighted = useMemo(() => {
    if (!language || code.length > HIGHLIGHT_LIMIT || !lowlight.registered(language)) return null;
    try {
      return render(lowlight.highlight(language, code).children as HastNode[]);
    } catch {
      return null;
    }
  }, [code, language]);
  return (
    <div className="sf-code-block">
      <div className="sf-code-block-head">
        <span>{language || t('代码')}</span>
        <button
          type="button"
          aria-label={copied ? t('已复制') : t('复制代码')}
          onClick={() =>
            void navigator.clipboard
              .writeText(code)
              .then(() => setCopied(true))
              .catch(() => {})
          }
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? t('已复制') : t('复制')}
        </button>
      </div>
      <pre>
        <code className={language ? `hljs language-${language}` : undefined}>
          {highlighted ?? code}
        </code>
      </pre>
    </div>
  );
}

/** The text of a hast node and everything in it. */
export function hastText(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}
