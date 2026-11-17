import { Check, ChevronRight, Circle, LoaderCircle } from 'lucide-react';
import { t } from '../../i18n';
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
