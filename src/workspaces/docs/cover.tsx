import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { Menu, type MenuAnchor } from '../../components/primitives/Menu';
import { t } from '../../i18n';

/** Preset covers: light gradients that sit well on a white page. */
export const COVERS = [
  'linear-gradient(120deg, #a1c4fd, #c2e9fb)',
  'linear-gradient(120deg, #fbc2eb, #a6c1ee)',
  'linear-gradient(120deg, #d4fc79, #96e6a1)',
  'linear-gradient(120deg, #ffecd2, #fcb69f)',
  'linear-gradient(120deg, #e0c3fc, #8ec5fc)',
  'linear-gradient(120deg, #84fab0, #8fd3f4)',
  'linear-gradient(120deg, #f6d365, #fda085)',
  'linear-gradient(120deg, #fdfbfb, #ebedee)',
];

/** What "添加封面" puts on: one of the presets, at random. */
export const defaultCover = () => `gradient:${Math.floor(Math.random() * COVERS.length)}`;

/** The CSS background of a gradient cover; null for an image one. */
export function coverGradient(cover: string) {
  const match = /^gradient:(\d+)$/.exec(cover);
  return match ? (COVERS[Number(match[1])] ?? COVERS[0]) : null;
}

/** The band above a page's title, as in Feishu, with "更换封面" and "移除" on hover. */
export function PageCover({
  cover,
  readOnly,
  loadImage,
  saveImage,
  onChange,
}: {
  cover: string;
  readOnly: boolean;
  loadImage(asset: string): Promise<string>;
  saveImage(file: File): Promise<string>;
  onChange(cover: string | null): void;
}) {
  const gradient = coverGradient(cover);
  const [image, setImage] = useState('');
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (gradient) return;
    let live = true;
    setImage('');
    void loadImage(cover)
      .then((url) => live && setImage(url))
      .catch(() => live && setImage(''));
    return () => {
      live = false;
    };
  }, [cover, gradient, loadImage]);
  return (
    <div
      className="doc-cover"
      style={{ background: gradient ?? (image ? `center / cover no-repeat url("${image}")` : '') }}
    >
      {readOnly ? null : (
        <div className="doc-cover-actions">
          <button
            type="button"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom + 4, trigger: event.currentTarget });
            }}
          >
            {t('更换封面')}
          </button>
          <button type="button" aria-label={t('移除封面')} onClick={() => onChange(null)}>
            <Trash2 size={13} />
          </button>
        </div>
      )}
      {error ? <span className="doc-cover-error">{error}</span> : null}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setError('');
          void saveImage(file)
            .then(onChange)
            .catch(() => setError(t('图片没能保存，请换一张再试。')));
        }}
      />
      <Menu anchor={menu} label={t('更换封面')} onClose={() => setMenu(null)}>
        <div className="doc-cover-presets">
          {COVERS.map((value, index) => (
            <button
              type="button"
              role="menuitem"
              key={value}
              aria-label={t('封面 {n}', { n: index + 1 })}
              style={{ background: value }}
              onClick={() => {
                setMenu(null);
                onChange(`gradient:${index}`);
              }}
            />
          ))}
        </div>
        <div role="separator" className="sf-menu-separator" />
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setMenu(null);
            input.current?.click();
          }}
        >
          <ImagePlus size={14} />
          {t('上传图片')}
        </button>
      </Menu>
    </div>
  );
}
