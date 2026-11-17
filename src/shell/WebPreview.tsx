import { useEffect, useState } from 'react';
import { BookOpen, Globe, X } from 'lucide-react';
import { Button } from '../components/primitives';
import { t } from '../i18n';
import { BrowserPane } from '../workspaces/literature/BrowserPane';
import './web-preview.css';

export type WebPreviewTarget = { projectId: string; tabId: string; url: string };

/**
 * A web page opened from an AI answer, over the current module's center: the
 * page shows without leaving what you were doing. "在文献页打开" keeps it as a
 * literature tab; closing leaves the module as it was.
 */
export function WebPreview({
  target,
  onClose,
  onKeep,
}: {
  target: WebPreviewTarget;
  onClose(): void;
  onKeep(url: string): void;
}) {
  const [title, setTitle] = useState(target.url);
  const [url, setUrl] = useState(target.url);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  return (
    <section className="sf-web-preview" aria-label={t('网页预览')}>
      <header className="sf-web-preview-head">
        <Globe size={14} aria-hidden="true" />
        <span className="sf-web-preview-title" title={url}>
          {title}
        </span>
        <Button size="sm" variant="ghost" onClick={() => onKeep(url)}>
          <BookOpen size={14} aria-hidden="true" />
          {t('在文献页打开')}
        </Button>
        <Button variant="ghost" iconOnly aria-label={t('关闭预览')} onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="sf-web-preview-body">
        <BrowserPane
          key={target.tabId}
          id={target.tabId}
          initialUrl={target.url}
          onChanged={(tab) => {
            setTitle(tab.title || tab.url);
            setUrl(tab.url);
          }}
        />
      </div>
    </section>
  );
}
