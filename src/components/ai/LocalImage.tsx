import { useEffect, useState } from 'react';
import { t } from '../../i18n';

/**
 * A picture the AI made on this computer (a chart in the AI workspace, say),
 * loaded through the app rather than by URL; click to open it in the center.
 */
export function LocalImage({
  src,
  alt,
  load,
  onOpen,
}: {
  src: string;
  alt?: string;
  load(src: string): Promise<Blob | null>;
  onOpen?(src: string): void;
}) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let made = '';
    setUrl('');
    setFailed(false);
    load(src)
      .then((blob) => {
        if (!alive) return;
        if (!blob) return setFailed(true);
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [src, load]);
  const label = alt || t('未命名图片');
  if (failed) return <span className="sf-muted">{t('[图片：{alt}]', { alt: label })}</span>;
  if (!url) return <span className="sf-chat-image is-loading" aria-label={label} />;
  return (
    <button
      type="button"
      className="sf-chat-image"
      title={t('在中间打开')}
      onClick={() => onOpen?.(src)}
    >
      <img src={url} alt={label} />
    </button>
  );
}
