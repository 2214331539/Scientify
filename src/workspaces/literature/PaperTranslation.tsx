import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Languages, RotateCcw, Square } from 'lucide-react';
import { Button } from '../../components/primitives';
import { confirmAction } from '../../components/prompts';
import { errorMessage } from '../../domain/errors';
import type { WorkContext } from '../../domain/context';
import { t } from '../../i18n';
import type { LibraryPaper } from '../../platform/library';
import { translator, type TranslationStatus, type Translator } from '../../platform/translator';
import type { WorkspaceStore } from '../../stores/workspace';
import {
  autoTranslate,
  setAutoTranslate,
  translationModel,
} from '../../features/translation/engine';

const PdfReader = lazy(() => import('../../reader/PdfReader'));
const IDLE: TranslationStatus = { state: 'idle', progress: 0, message: '' };

/**
 * A paper's full-text translation beside it: a PDF with the original's layout,
 * formulas and figures, made once (by itself for new papers) and kept with the paper.
 */
export function PaperTranslation({
  projectId,
  paper,
  title,
  store,
  readOnly,
  onContext,
  engine = translator,
}: {
  projectId: string;
  paper?: LibraryPaper;
  title: string;
  store: WorkspaceStore;
  readOnly: boolean;
  onContext?: (context: WorkContext) => void;
  engine?: Translator;
}) {
  const paperId = paper?.id ?? '';
  const [status, setStatus] = useState<TranslationStatus | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [auto, setAuto] = useState(autoTranslate);
  useEffect(() => {
    if (!paperId) return;
    let live = true;
    void engine
      .status(projectId, paperId)
      .then((value) => live && setStatus(value))
      .catch((reason) => live && (setStatus(IDLE), setError(errorMessage(reason))));
    const stop = engine.events((event) => {
      if (event.projectId !== projectId || event.paperId !== paperId) return;
      setStatus(event.status);
      if (event.status.state === 'done') setVersion((n) => n + 1);
    });
    return () => {
      live = false;
      void stop.then((unlisten) => unlisten());
    };
  }, [engine, projectId, paperId]);
  const backend = useMemo(
    () => ({ readPdf: () => engine.pdf(projectId, paperId) }),
    [engine, projectId, paperId],
  );

  async function start(again = false) {
    if (!paper) return;
    if (again && !(await confirmAction(t('重新翻译会替换现有译文，继续吗？')))) return;
    setError('');
    try {
      setStatus(await engine.request(projectId, paper.id, await translationModel(store), again));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }
  async function stop() {
    try {
      await engine.cancel(projectId, paperId);
      setStatus(IDLE);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  const running =
    status?.state === 'queued' || status?.state === 'preparing' || status?.state === 'translating';
  const problem = error || (status?.state === 'failed' ? status.message : '');
  return (
    <section className="paper-translation" aria-label={t('全文翻译')}>
      {status?.state === 'done' && paper ? (
        <>
          <header className="paper-translation-bar">
            <span className="muted">{t('译文保留原文排版')}</span>
            <span className="spacer" />
            <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => void start(true)}>
              <RotateCcw size={13} />
              {t('重新翻译')}
            </Button>
          </header>
          <div className="paper-translation-reader">
            <Suspense fallback={<p className="muted">{t('正在打开阅读器…')}</p>}>
              <PdfReader
                key={version}
                assetId={`translation:${paper.id}:${version}`}
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
        </>
      ) : status === null ? (
        <p className="muted paper-translation-empty">{t('正在读取…')}</p>
      ) : (
        <div className="paper-translation-empty">
          <Languages size={22} aria-hidden="true" />
          {running ? (
            <>
              <p role="status">
                {status.state === 'translating'
                  ? t('正在翻译 {progress}%', { progress: Math.round(status.progress) })
                  : status.state === 'preparing'
                    ? t('正在准备翻译组件，只需一次')
                    : t('排队中')}
              </p>
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
              <Button size="sm" variant="ghost" onClick={() => void stop()}>
                <Square size={12} />
                {t('停止')}
              </Button>
            </>
          ) : (
            <>
              <p>{t('翻译整篇论文，保留原文的排版、公式和图表。')}</p>
              {problem ? (
                <p role="alert" className="error-text">
                  {problem}
                </p>
              ) : null}
              <Button variant="primary" disabled={readOnly || !paper} onClick={() => void start()}>
                {status.state === 'failed' ? t('重试') : t('开始翻译')}
              </Button>
            </>
          )}
          <label className="paper-translation-auto">
            <input
              type="checkbox"
              checked={auto}
              onChange={(event) => {
                setAuto(event.target.checked);
                setAutoTranslate(event.target.checked);
              }}
            />
            {t('新下载的论文自动翻译')}
          </label>
        </div>
      )}
    </section>
  );
}
