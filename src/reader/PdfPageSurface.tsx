import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AnnotationLayer, AnnotationType, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import { pdfLinkLabel, type ReaderLinkService } from './pdf-links';
import { t } from '../i18n';

/** Keep geometry while releasing canvases and text layers far from the viewport. */
export function PdfPageSurface({
  document,
  page,
  width,
  zoom,
  visible,
  title,
  linkService,
  onReady,
  onError,
  onSelection,
}: {
  document: PDFDocumentProxy;
  page: number;
  width: number;
  zoom: number;
  visible: boolean;
  title: string;
  linkService: ReaderLinkService;
  onReady(page: number, text: string): void;
  onError(message: string): void;
  onSelection(page: number, text: string, selection: string): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    textLayer = useRef<HTMLDivElement>(null),
    annotationLayer = useRef<HTMLDivElement>(null);
  const [base, setBase] = useState({ width: 600, height: 800 });
  const [loading, setLoading] = useState(true);
  const callbacks = useRef({ onReady, onError, onSelection });
  callbacks.current = { onReady, onError, onSelection };
  const text = useRef('');
  const scale = Math.max(0.25, Math.min(3, width / base.width)) * zoom;
  useEffect(() => {
    if (!visible) return;
    let stale = false;
    let renderTask:
      ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    let layer: TextLayer | undefined;
    let links: AnnotationLayer | undefined;
    setLoading(true);
    void document
      .getPage(page)
      .then(async (pdfPage) => {
        if (stale || !canvas.current || !textLayer.current || !annotationLayer.current) return;
        const original = pdfPage.getViewport({ scale: 1 });
        setBase({ width: original.width, height: original.height });
        const scale = Math.max(0.25, Math.min(3, width / original.width)) * zoom;
        const viewport = pdfPage.getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const node = canvas.current;
        node.width = Math.floor(viewport.width * dpr);
        node.height = Math.floor(viewport.height * dpr);
        node.style.width = `${viewport.width}px`;
        node.style.height = `${viewport.height}px`;
        textLayer.current.replaceChildren();
        annotationLayer.current.replaceChildren();
        renderTask = pdfPage.render({
          canvas: node,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        });
        void renderTask.promise.catch(() => undefined);
        const [content, annotations] = await Promise.all([
          pdfPage.getTextContent(),
          pdfPage.getAnnotations({ intent: 'display' }),
        ]);
        if (stale) return;
        text.current = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .slice(0, 24000);
        layer = new TextLayer({
          textContentSource: content,
          container: textLayer.current!,
          viewport,
        });
        const linkViewport = viewport.clone({ dontFlip: true });
        links = new AnnotationLayer({
          div: annotationLayer.current!,
          page: pdfPage,
          viewport: linkViewport,
          linkService,
          accessibilityManager: null,
          annotationCanvasMap: null,
          annotationEditorUIManager: null,
          structTreeLayer: null,
          commentManager: null,
          annotationStorage: null,
        });
        await Promise.all([
          renderTask.promise,
          layer.render(),
          links.render({
            viewport: linkViewport,
            div: annotationLayer.current!,
            page: pdfPage,
            linkService,
            annotations: annotations.filter(
              (annotation) =>
                annotation.annotationType === AnnotationType.LINK &&
                (annotation.url ||
                  annotation.dest ||
                  ['NextPage', 'PrevPage', 'FirstPage', 'LastPage'].includes(annotation.action)),
            ),
            renderForms: false,
            enableScripting: false,
          }),
        ]);
        if (!stale) {
          for (const link of annotationLayer.current!.querySelectorAll('a'))
            link.setAttribute('aria-label', pdfLinkLabel(link));
          setLoading(false);
          callbacks.current.onReady(page, text.current);
          linkService.eventBus.dispatch('textlayerrendered', {
            pageNumber: page,
            source: {
              textLayer: {
                div: { focus: () => textLayer.current?.focus({ preventScroll: true }) },
              },
            },
          });
        }
      })
      .catch((error) => {
        if (!stale && error?.name !== 'RenderingCancelledException') {
          setLoading(false);
          callbacks.current.onError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      stale = true;
      renderTask?.cancel();
      layer?.cancel();
      links?.destroy();
    };
  }, [document, page, width, zoom, visible, linkService]);
  function select() {
    const selected = window.getSelection();
    if (!selected || !textLayer.current?.contains(selected.anchorNode)) return;
    callbacks.current.onSelection(page, text.current, selected.toString().trim().slice(0, 16000));
  }
  return (
    <div
      className="pdf-page"
      data-pdf-page={page}
      style={
        {
          width: base.width * scale,
          height: base.height * scale,
          '--scale-factor': scale,
          '--total-scale-factor': scale,
        } as CSSProperties
      }
    >
      {visible && (
        <>
          {loading && (
            <span className="pdf-loading" role="status">
              {t('正在读取 PDF…')}
            </span>
          )}
          <canvas ref={canvas} aria-label={t('{title} 第 {page} 页', { title, page })} />
          <div
            className="textLayer"
            ref={textLayer}
            tabIndex={-1}
            onMouseUp={select}
            onKeyUp={select}
          />
          <div className="annotationLayer" ref={annotationLayer} />
        </>
      )}
    </div>
  );
}
