import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Languages, RotateCcw, Square } from 'lucide-react';
import { Button } from '../../components/primitives';
import { confirmAction } from '../../components/prompts';
import { errorMessage } from '../../domain/errors';
import { t } from '../../i18n';
import { getPreferences } from '../../i18n/preferences';
import type { LibraryBackend, LibraryPaper } from '../../platform/library';
import type { ResearchBackend } from '../../platform/research';
import type { WorkspaceStore } from '../../stores/workspace';
import { loadConnectionKey } from '../../features/assistant/connections';
import type { AISettings } from '../../features/assistant/model';
import { Markdown } from '../../features/notes/Markdown';
import { loadTextPdf, pdfPageText } from '../../reader/pdf-text';
import {
  loadTranslation,
  translatePaper,
  translationJobs,
} from '../../features/translation/paper-translation';

/**
 * A paper's full-text translation, in its note pane beside the PDF: made on
 * request with the assistant's model, kept with the paper, pages linking back.
 */
export function PaperTranslation({
  projectId,
  paper,
  title,
  library,
  backend,
  store,
  readOnly,
  onPage,
}: {
  projectId: string;
  paper?: LibraryPaper;
  title: string;
  library: LibraryBackend;
  backend: ResearchBackend;
  store: WorkspaceStore;
  readOnly: boolean;
  onPage(page: number): void;
}) {
  const paperId = paper?.id ?? '';
  const job = useSyncExternalStore(
    useCallback(
      (listener: () => void) => translationJobs.subscribe(projectId, paperId, listener),
      [projectId, paperId],
    ),
    () => translationJobs.get(projectId, paperId),
  );
  const [stored, setStored] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [preparing, setPreparing] = useState(false);
  useEffect(() => {
    if (!paperId) return;
    let live = true;
    void loadTranslation(projectId, paperId)
      .then((content) => live && setStored(content))
      .catch((reason) => live && (setStored(null), setError(errorMessage(reason))));
    return () => {
      live = false;
    };
  }, [projectId, paperId]);
  const content = job.content ?? stored;
  const running = job.running || preparing;

  async function start() {
    if (!paper || running) return;
    if (content && !(await confirmAction(t('重新翻译会替换现有译文，继续吗？')))) return;
    setError('');
    setPreparing(true);
    try {
      const settings = store.getState().data?.settings.model as AISettings | undefined;
      if (!settings?.model) throw new Error(t('请先在设置里选好 AI 模型。'));
      const apiKey = await loadConnectionKey(settings);
      const task = await loadTextPdf(await library.pdf(projectId, paper.id));
      const pages: string[] = [];
      try {
        const pdf = await task.promise;
        for (let page = 1; page <= pdf.numPages; page++) pages.push(await pdfPageText(pdf, page));
      } finally {
        void task.destroy();
      }
      const chinese = getPreferences().language === 'zh-CN';
      setPreparing(false);
      await translatePaper({
        projectId,
        paperId: paper.id,
        title: t('{title}（全文翻译）', { title }),
        pages,
        ask: ({ messages }) =>
          backend.askAI({
            provider: settings.provider,
            endpoint: settings.endpoint,
            apiKey,
            model: settings.model,
            messages,
          }),
        language: chinese ? '简体中文' : 'English',
        note: t('由 {model} 翻译，{date}。点页码回到原文。', {
          model: settings.model,
          date: new Date().toLocaleDateString(),
        }),
        pageLabel: (page) => t('第 {page} 页', { page }),
        pending: t('（未翻译）'),
      });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPreparing(false);
    }
  }

  const problem = error || job.error;
  return (
    <section className="paper-translation" aria-label={t('全文翻译')}>
      <header className="paper-translation-bar">
        {running ? (
          <>
            <span className="paper-translation-progress" role="status">
              {preparing
                ? t('正在读取论文…')
                : t('正在翻译 {done}/{total} 段', { done: job.done, total: job.total })}
              <progress max={job.total || 1} value={job.done} />
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={preparing}
              onClick={() => translationJobs.cancel(projectId, paperId)}
            >
              <Square size={13} />
              {t('停止')}
            </Button>
          </>
        ) : content ? (
          <>
            <span className="paper-translation-progress muted">{t('译文')}</span>
            <Button size="sm" variant="ghost" disabled={readOnly || !paper} onClick={start}>
              <RotateCcw size={13} />
              {t('重新翻译')}
            </Button>
          </>
        ) : null}
      </header>
      {problem ? (
        <p role="alert" className="error-text paper-translation-error">
          {problem}
        </p>
      ) : null}
      {content ? (
        <div className="paper-translation-body">
          <Markdown onPage={onPage}>{content}</Markdown>
        </div>
      ) : content === null && !running ? (
        <div className="paper-translation-empty">
          <Languages size={22} aria-hidden="true" />
          <p>{t('把整篇论文逐段翻译出来，保存在这篇论文名下，以后直接打开。')}</p>
          <p className="muted">{t('会按段调用当前的 AI 模型，长论文需要几分钟。')}</p>
          <Button variant="primary" disabled={readOnly || !paper} onClick={start}>
            {t('开始翻译')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
