import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Languages } from 'lucide-react';
import type { WorkContext } from '../../domain/context';
import { t } from '../../i18n';
import type { LibraryPaper } from '../../platform/library';
import { translator, type TranslationStatus, type Translator } from '../../platform/translator';

const PdfReader = lazy(() => import('../../reader/PdfReader'));
/** A translation finished on another device arrives by sync; look again now and then. */
const POLL = 5000;

/**
 * A paper's full-text translation beside it: a PDF with the original's layout,
 * formulas and figures. Translation happens in the background by itself; opening the
 * pane only shows it, or how far it has got.
 */
export function PaperTranslation({
  projectId,
  paper,
  title,
  onContext,
  engine = translator,
}: {
  projectId: string;
  paper?: LibraryPaper;
  title: string;
  onContext?: (context: WorkContext) => void;
  engine?: Translator;
}) {
  const paperId = paper?.id ?? '';
  const fingerprint = paper?.fingerprint ?? '';
  const [status, setStatus] = useState<TranslationStatus | null>(null);
  const done = status?.state === 'done';
  useEffect(() => {
    if (!paperId) return;
    let live = true;
    const show = (value: TranslationStatus) => live && setStatus(value);
    void engine
      .open(projectId, paperId)
      .then(show)
      .catch(() => show({ state: 'waiting', progress: 0 }));
    const stop = engine.events((event) => {
      if (event.projectId === projectId && event.fingerprint === fingerprint) show(event.status);
    });
    return () => {
      live = false;
      void stop.then((unlisten) => unlisten());
    };
  }, [engine, projectId, paperId, fingerprint]);
  useEffect(() => {
    if (!paperId || done) return;
    const timer = window.setInterval(() => {
      void engine
        .status(projectId, paperId)
        .then((value) => value.state === 'done' && setStatus(value))
        .catch(() => {});
    }, POLL);
    return () => window.clearInterval(timer);
  }, [engine, projectId, paperId, done]);
  const backend = useMemo(
    () => ({ readPdf: () => engine.pdf(projectId, paperId) }),
    [engine, projectId, paperId],
  );

  return (
    <section className="paper-translation" aria-label={t('全文翻译')}>
      {done && paper ? (
        <div className="paper-translation-reader">
          <Suspense fallback={<p className="muted">{t('正在打开阅读器…')}</p>}>
            <PdfReader
              assetId={`translation:${paper.id}:${fingerprint}`}
              paperId={paper.id}
              title={t('{title}（译文）', { title })}
              projectId={projectId}
              backend={backend}
              compact
              onContext={(context) => onContext?.(context)}
              onTool={() => {}}
            />
          </Suspense>
        </div>
      ) : (
        <div className="paper-translation-empty">
          <Languages size={22} aria-hidden="true" />
          <p role="status">
            {status?.state === 'translating' && status.progress > 0
              ? t('正在翻译 {progress}%', { progress: Math.round(status.progress) })
              : t('正在翻译…')}
          </p>
          {status?.state === 'translating' ? (
            <div
              className="paper-translation-meter"
              role="progressbar"
              aria-label={t('翻译进度')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(status.progress)}
            >
              <span style={{ width: `${Math.max(3, status.progress)}%` }} />
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
