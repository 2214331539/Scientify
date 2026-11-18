import {
  Check,
  ChevronRight,
  Circle,
  FileMinus,
  FilePen,
  FilePlus,
  LoaderCircle,
  Undo2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { Mascot } from '../../components/ai/Mascot';
import type { AgentPlanStep } from './agent-session';

/** The steps the Agent planned for this turn, ticked off as it goes. */
export function PlanList({ plan }: { plan: AgentPlanStep[] }) {
  if (!plan.length) return null;
  const done = plan.filter((step) => step.status === 'completed').length;
  return (
    <section className="sf-ai-plan" aria-label={t('执行计划')}>
      <header>
        {t('计划')} · {done}/{plan.length}
      </header>
      <ol>
        {plan.map((step, index) => (
          <li key={index} className={`is-${step.status}`}>
            {step.status === 'completed' ? (
              <Check size={13} aria-label={t('已完成')} />
            ) : step.status === 'inProgress' ? (
              <LoaderCircle size={13} className="sf-ai-spinner" aria-label={t('进行中')} />
            ) : (
              <Circle size={13} aria-label={t('待做')} />
            )}
            <span>{step.step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

type DiffFile = { path: string; added: number; removed: number; lines: string[] };

/** Splits a unified diff into files with their added and removed line counts. */
export function diffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const path = line.match(/ b\/(.+)$/)?.[1] ?? line.slice(11);
      files.push({ path, added: 0, removed: 0, lines: [] });
      continue;
    }
    const file = files[files.length - 1];
    if (!file) continue;
    if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity |rename )/.test(line))
      continue;
    if (line.startsWith('+')) file.added += 1;
    else if (line.startsWith('-')) file.removed += 1;
    file.lines.push(line);
  }
  return files;
}

/** What this turn changed in the project's files, file by file. */
export function TurnDiff({ diff }: { diff: string }) {
  const files = diffFiles(diff);
  if (!files.length) return null;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <details className="sf-ai-task-details sf-ai-diff">
      <summary className="sf-disclosure">
        <ChevronRight size={13} aria-hidden="true" />
        {t('本轮改动 · {count} 个文件', { count: files.length })}
        <span className="sf-ai-diff-add">+{added}</span>
        <span className="sf-ai-diff-del">−{removed}</span>
      </summary>
      {files.map((file) => (
        <details key={file.path} className="sf-ai-diff-file">
          <summary>
            <code>{file.path}</code>
            <span className="sf-ai-diff-add">+{file.added}</span>
            <span className="sf-ai-diff-del">−{file.removed}</span>
          </summary>
          <pre>
            {file.lines.slice(0, 800).map((line, index) => (
              <span
                key={index}
                className={
                  line.startsWith('+')
                    ? 'is-add'
                    : line.startsWith('-')
                      ? 'is-del'
                      : line.startsWith('@@')
                        ? 'is-hunk'
                        : undefined
                }
              >
                {line}
                {'\n'}
              </span>
            ))}
          </pre>
        </details>
      ))}
    </details>
  );
}

/** "已思考 N 秒": what the model thought, when it shares it; open while it is thinking. */
export function Thinking({
  reasoning,
  thinkingSince,
  thoughtMs,
}: {
  reasoning?: string;
  thinkingSince?: number | null;
  thoughtMs?: number | null;
}) {
  if (!reasoning && !thinkingSince && !thoughtMs) return null;
  const done = typeof thoughtMs === 'number';
  const label = done
    ? t('已思考 {seconds} 秒', { seconds: Math.max(1, Math.round(thoughtMs / 1000)) })
    : t('正在思考…');
  if (!reasoning) return <div className="sf-ai-thinking is-bare">{label}</div>;
  return (
    <details className="sf-ai-thinking" open={!done}>
      <summary className="sf-disclosure">
        <ChevronRight size={13} aria-hidden="true" />
        {label}
      </summary>
      <div className="sf-ai-thinking-text">{reasoning}</div>
    </details>
  );
}

const FILE_KINDS = { add: '新建', update: '修改', delete: '删除' } as const;

/**
 * The files this turn created, changed or deleted; click one to see it in the
 * center. The last turn's can be put back as they were.
 */
export function TurnFiles({
  files,
  cwd,
  onOpen,
  onUndo,
  undone,
}: {
  files: { path: string; kind: keyof typeof FILE_KINDS }[];
  cwd?: string | null;
  onOpen?(path: string): void;
  onUndo?(): Promise<void>;
  undone?: boolean;
}) {
  const [undoing, setUndoing] = useState(false);
  if (!files.length) return null;
  const absolute = (path: string) =>
    /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path) || !cwd ? path : `${cwd.replace(/[\\/]+$/, '')}/${path}`;
  return (
    <div className={`sf-ai-files${undone ? ' is-undone' : ''}`} aria-label={t('本轮文件')}>
      {files.map((file) => {
        const name = file.path.split(/[\\/]/).at(-1) ?? file.path;
        const path = absolute(file.path);
        return (
          <button
            key={file.path}
            type="button"
            className={`sf-ai-file is-${file.kind}`}
            title={path}
            disabled={file.kind === 'delete' || !onOpen}
            onClick={() => onOpen?.(path)}
          >
            {file.kind === 'add' ? (
              <FilePlus size={13} aria-hidden="true" />
            ) : file.kind === 'delete' ? (
              <FileMinus size={13} aria-hidden="true" />
            ) : (
              <FilePen size={13} aria-hidden="true" />
            )}
            <span>{name}</span>
            <small>{t(FILE_KINDS[file.kind])}</small>
          </button>
        );
      })}
      {undone ? (
        <span className="sf-ai-files-note">{t('已撤销')}</span>
      ) : onUndo ? (
        <button
          type="button"
          className="sf-ai-files-undo"
          disabled={undoing}
          onClick={() => {
            setUndoing(true);
            void onUndo().finally(() => setUndoing(false));
          }}
        >
          <Undo2 size={13} aria-hidden="true" />
          {undoing ? t('正在撤销…') : t('撤销修改')}
        </button>
      ) : null}
    </div>
  );
}

/** "45 秒", "4 分 28 秒". */
export function duration(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60
    ? t('{s} 秒', { s: seconds })
    : t('{m} 分 {s} 秒', { m: Math.floor(seconds / 60), s: seconds % 60 });
}

type Operation = { id: string; label: string; status: string; output: string };

/**
 * One turn's work, above its answer: "正在搜索网页… · 12 秒" while it runs,
 * "已处理 4 分 28 秒" after, opening to what the model thought, its plan, each
 * step it took and the files it changed.
 */
export function TurnProcess({
  running,
  status,
  startedAt,
  completedAt,
  reasoning,
  plan,
  operations,
  diff,
}: {
  running: boolean;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  reasoning?: string;
  plan: AgentPlanStep[];
  operations: Operation[];
  diff?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const end = running ? now : completedAt ? Date.parse(completedAt) : NaN;
  const elapsed = Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
  const empty = !reasoning && !plan.length && !operations.length && !diff;
  if (!running && empty) return null;
  const label = running
    ? [status || t('正在处理…'), elapsed !== null ? duration(elapsed) : '']
        .filter(Boolean)
        .join(' · ')
    : elapsed !== null
      ? t('已处理 {time}', { time: duration(elapsed) })
      : t('处理过程');
  return (
    <details className={`sf-ai-process${running ? ' is-running' : ''}`} open={running}>
      <summary>
        {running ? <Mascot size={16} mood="working" /> : null}
        <span>{label}</span>
        {!empty ? (
          <ChevronRight size={13} aria-hidden="true" className="sf-ai-process-chevron" />
        ) : null}
      </summary>
      {!empty ? (
        <div className="sf-ai-process-body">
          {reasoning ? <div className="sf-ai-thinking-text">{reasoning}</div> : null}
          <PlanList plan={plan} />
          {operations.length ? (
            <ol className="sf-ai-steps">
              {operations.map((op) => (
                <li key={op.id} className={`is-${op.status}`}>
                  {op.output ? (
                    <details>
                      <summary>{op.label}</summary>
                      <pre>{op.output}</pre>
                    </details>
                  ) : (
                    <span>{op.label}</span>
                  )}
                </li>
              ))}
            </ol>
          ) : null}
          {diff ? <TurnDiff diff={diff} /> : null}
        </div>
      ) : null}
    </details>
  );
}
