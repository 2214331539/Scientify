import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

/** A Word document rendered in the app, close to its print layout. */
export function DocxView({ bytes }: { bytes: Uint8Array }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const target = host.current;
    if (!target) return;
    let alive = true;
    target.replaceChildren();
    void import('docx-preview')
      .then(({ renderAsync }) =>
        renderAsync(new Blob([new Uint8Array(bytes)]), target, undefined, {
          inWrapper: true,
          ignoreLastRenderedPageBreak: true,
          experimental: true,
        }),
      )
      .catch(() => alive && setError(t('这个 Word 文件无法预览，可以用系统程序打开。')));
    return () => {
      alive = false;
    };
  }, [bytes]);
  return error ? (
    <p className="sf-file-loading">{error}</p>
  ) : (
    <div ref={host} className="sf-docx" />
  );
}

type Slide = { title: string; lines: string[]; images: string[] };

const NUMBER = /^ppt\/slides\/slide(\d+)\.xml$/;

/** The text of each paragraph in a slide part. */
function paragraphs(node: Element) {
  return [...node.getElementsByTagName('a:p')]
    .map((p) =>
      [...p.getElementsByTagName('a:t')]
        .map((run) => run.textContent ?? '')
        .join('')
        .trim(),
    )
    .filter(Boolean);
}

async function readSlides(bytes: Uint8Array): Promise<Slide[]> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files)
    .filter((name) => NUMBER.test(name))
    .sort((a, b) => Number(NUMBER.exec(a)![1]) - Number(NUMBER.exec(b)![1]));
  const parser = new DOMParser();
  const slides: Slide[] = [];
  for (const name of names) {
    const xml = parser.parseFromString(await zip.file(name)!.async('string'), 'application/xml');
    let title = '';
    const lines: string[] = [];
    for (const shape of [...xml.getElementsByTagName('p:sp')]) {
      const kind = shape.getElementsByTagName('p:ph')[0]?.getAttribute('type') ?? '';
      const text = paragraphs(shape);
      if (!title && /title/i.test(kind)) title = text.join(' ');
      else lines.push(...text);
    }
    // Pictures: r:embed ids resolved through the slide's relationships.
    const rels = zip.file(name.replace('slides/', 'slides/_rels/') + '.rels');
    const targets = new Map<string, string>();
    if (rels) {
      const doc = parser.parseFromString(await rels.async('string'), 'application/xml');
      for (const rel of [...doc.getElementsByTagName('Relationship')])
        targets.set(rel.getAttribute('Id') ?? '', rel.getAttribute('Target') ?? '');
    }
    const images: string[] = [];
    for (const blip of [...xml.getElementsByTagName('a:blip')]) {
      const target = targets.get(blip.getAttribute('r:embed') ?? '');
      const file = target && zip.file(`ppt/${target.replace(/^\.\.\//, '')}`);
      if (file) images.push(URL.createObjectURL(await file.async('blob')));
    }
    slides.push({ title, lines, images });
  }
  return slides;
}

/** A PowerPoint deck as its slides' titles, text and pictures. */
export function PptxView({ bytes }: { bytes: Uint8Array }) {
  const [slides, setSlides] = useState<Slide[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let made: Slide[] = [];
    readSlides(bytes)
      .then((value) => {
        made = value;
        if (alive) setSlides(value);
      })
      .catch(() => alive && setError(t('这个演示文稿无法预览，可以用系统程序打开。')));
    return () => {
      alive = false;
      for (const slide of made) slide.images.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [bytes]);
  if (error) return <p className="sf-file-loading">{error}</p>;
  if (!slides) return <p className="sf-file-loading">{t('正在读取…')}</p>;
  if (!slides.length) return <p className="sf-file-loading">{t('演示文稿里没有幻灯片')}</p>;
  return (
    <div className="sf-slides">
      <p className="sf-slides-note">{t('按页显示文字和图片，版式以系统程序打开为准。')}</p>
      {slides.map((slide, index) => (
        <section key={index} className="sf-slide" aria-label={t('第 {n} 页', { n: index + 1 })}>
          <span className="sf-slide-number">{index + 1}</span>
          {slide.title ? <h3>{slide.title}</h3> : null}
          {slide.lines.length ? (
            <ul>
              {slide.lines.map((line, at) => (
                <li key={at}>{line}</li>
              ))}
            </ul>
          ) : null}
          {slide.images.length ? (
            <div className="sf-slide-images">
              {slide.images.map((url) => (
                <img key={url} src={url} alt="" />
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
