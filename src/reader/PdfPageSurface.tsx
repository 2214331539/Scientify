import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
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
  const surface = useRef<HTMLDivElement>(null);
  const [base, setBase] = useState({ width: 600, height: 800 });
  const [loading, setLoading] = useState(true);
  const callbacks = useRef({ onReady, onError, onSelection });
  callbacks.current = { onReady, onError, onSelection };
  const text = useRef('');
  const painted = useRef<{ node: HTMLDivElement; scale: number; dispose(): void } | null>(null);
  const scale = Math.max(0.25, Math.min(3, width / base.width)) * zoom;
  useLayoutEffect(() => {
    return () => {
      painted.current?.dispose();
      painted.current = null;
      surface.current?.replaceChildren();
    };
  }, [document, page, visible]);
  useLayoutEffect(() => {
    // Resize the complete painted frame before the next paint, including its
    // selection and link hit areas. A sharper replacement is prepared below.
    if (painted.current)
      painted.current.node.style.transform = `scale(${scale / painted.current.scale})`;
  }, [scale]);
  useEffect(() => {
    const host = surface.current;
    if (!visible || !host) return;
    // A render owns its nodes. A cancelled render must never clear or write
    // into the nodes created by a later zoom, resize or page switch.
    const dom = host.ownerDocument;
    const frame = dom.createElement('div');
    frame.className = 'pdf-page-frame';
    const node = dom.createElement('canvas');
    node.setAttribute('aria-label', t('{title} 第 {page} 页', { title, page }));
    const textNode = dom.createElement('div');
    textNode.className = 'textLayer';
    textNode.tabIndex = -1;
    const annotationNode = dom.createElement('div');
    annotationNode.className = 'annotationLayer';
    frame.append(node, textNode, annotationNode);
    let stale = false;
    let published = false;
    let renderTask:
      ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    let layer: TextLayer | undefined;
    let links: AnnotationLayer | undefined;
    setLoading(!painted.current);
    // Coalesce wheel/resize bursts without ever removing the visible frame.
    let rendering: Promise<void> | undefined;
    const timer = setTimeout(
      () => {
        rendering = document
          .getPage(page)
          .then(async (pdfPage) => {
            if (stale) return;
            const original = pdfPage.getViewport({ scale: 1 });
            setBase({ width: original.width, height: original.height });
            const scale = Math.max(0.25, Math.min(3, width / original.width)) * zoom;
            const viewport = pdfPage.getViewport({ scale });
            frame.style.width = `${viewport.width}px`;
            frame.style.height = `${viewport.height}px`;
            frame.style.setProperty('--scale-factor', String(scale));
            frame.style.setProperty('--total-scale-factor', String(scale));
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            node.width = Math.floor(viewport.width * dpr);
            node.height = Math.floor(viewport.height * dpr);
            node.style.width = `${viewport.width}px`;
            node.style.height = `${viewport.height}px`;
            renderTask = pdfPage.render({
              canvas: node,
              viewport,
              transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
            });
            // Observe cancellation immediately, including while text is loading.
            const [content, annotations] = await Promise.all([
              pdfPage.getTextContent(),
              pdfPage.getAnnotations({ intent: 'display' }),
              renderTask.promise,
            ]);
            if (stale) return;
            const pageText = content.items
              .map((item) => ('str' in item ? item.str : ''))
              .join(' ')
              .slice(0, 24000);
            layer = new TextLayer({
              textContentSource: content,
              container: textNode,
              viewport,
            });
            const linkViewport = viewport.clone({ dontFlip: true });
            links = new AnnotationLayer({
              div: annotationNode,
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
                div: annotationNode,
                page: pdfPage,
                linkService,
                annotations: annotations.filter(
                  (annotation) =>
                    annotation.annotationType === AnnotationType.LINK &&
                    (annotation.url ||
                      annotation.dest ||
                      ['NextPage', 'PrevPage', 'FirstPage', 'LastPage'].includes(
                        annotation.action,
                      )),
                ),
                renderForms: false,
                enableScripting: false,
              }),
            ]);
            if (!stale) {
              for (const link of annotationNode.querySelectorAll('a'))
                link.setAttribute('aria-label', pdfLinkLabel(link));
              painted.current?.dispose();
              host.replaceChildren(frame);
              painted.current = { node: frame, scale, dispose: () => links?.destroy() };
              published = true;
              text.current = pageText;
              setLoading(false);
              callbacks.current.onReady(page, text.current);
              linkService.eventBus.dispatch('textlayerrendered', {
                pageNumber: page,
                source: {
                  textLayer: {
                    div: { focus: () => textNode.focus({ preventScroll: true }) },
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
      },
      painted.current ? 100 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
      renderTask?.cancel();
      layer?.cancel();
      // AnnotationLayer has no cancel API. Destroy it after its async render
      // settles; its detached nodes belong only to this effect.
      void rendering?.then(() => {
        if (!published) links?.destroy();
      });
    };
  }, [document, page, width, zoom, visible, linkService]);
  function select() {
    const selected = window.getSelection();
    if (!selected || !surface.current?.querySelector('.textLayer')?.contains(selected.anchorNode))
      return;
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
          <div className="pdf-page-surface" ref={surface} onMouseUp={select} onKeyUp={select} />
        </>
      )}
    </div>
  );
}
