import { useEffect, useState } from 'react';
import { FileDiff, RefreshCw, ArrowUpRight } from 'lucide-react';
import { Button } from '../../components/primitives';
import { t, translateError } from '../../i18n';
import type { ResearchBackend, GitChange } from '../../platform/research';
import { describeError, experimentApi } from './runtime';
export type DiffRow = {
  oldNumber?: number;
  newNumber?: number;
  oldText?: string;
  newText?: string;
  kind: 'context' | 'change' | 'heading';
};
export function splitPatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let old = 0,
    next = 0;
  let inHunk = false;
  const removed: DiffRow[] = [];
  const added: DiffRow[] = [];
  function flush() {
    for (let i = 0; i < Math.max(removed.length, added.length); i++)
      rows.push({ ...removed[i], ...added[i], kind: 'change' });
    removed.length = 0;
    added.length = 0;
  }
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush();
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: 'heading', oldText: line, newText: line });
    } else if (inHunk && line.startsWith('-'))
      removed.push({ kind: 'change', oldNumber: old++, oldText: line.slice(1) });
    else if (inHunk && line.startsWith('+'))
      added.push({ kind: 'change', newNumber: next++, newText: line.slice(1) });
    else if (inHunk && line.startsWith(' ')) {
      flush();
      rows.push({
        kind: 'context',
        oldNumber: old++,
        newNumber: next++,
        oldText: line.slice(1),
        newText: line.slice(1),
      });
    }
  }
  flush();
  return rows;
}
export function ChangesWorkspace({
  projectId,
  backend,
  onOpen,
  canOpenFile = true,
}: {
  projectId: string;
  backend: ResearchBackend;
  onOpen(path: string): void;
  canOpenFile?: boolean;
}) {
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [path, setPath] = useState('');
  const [patch, setPatch] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    backend
      .gitStatus(projectId)
      .then((result) => {
        if (alive) {
          setChanges(result);
          setPath((current) =>
            result.some((r) => r.path === current) ? current : result[0]?.path || '',
          );
          setLoading(false);
        }
      })
      .catch((e) => {
        if (alive) {
          setError(describeError(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [projectId, backend, revision]);
  useEffect(() => {
    let alive = true;
    setPatch('');
    if (path)
      experimentApi
        .diff(projectId, path)
        .then((value) => {
          if (alive) {
            setPatch(value);
            setError('');
          }
        })
        .catch((e) => {
          if (alive) setError(describeError(e));
        });
    return () => {
      alive = false;
    };
  }, [projectId, path, revision]);
  return (
    <div className="sf-experiment-changes">
      <aside>
        <header>
          <span>
            {t('修改的文件')} ({changes.length})
          </span>
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('刷新 Git 差异')}
            onClick={() => setRevision((r) => r + 1)}
          >
            <RefreshCw size={14} />
          </Button>
        </header>
        {changes.map((change) => (
          <Button
            variant="ghost"
            key={change.path}
            aria-pressed={path === change.path}
            onClick={() => setPath(change.path)}
          >
            <FileDiff size={14} />
            <span>{change.path}</span>
            <code>{change.status}</code>
          </Button>
        ))}
      </aside>
      <section>
        <header>
          <span>{path || t('Changes')}</span>
          <span className="spacer" />
          {path && (
            <Button
              disabled={!canOpenFile}
              title={!canOpenFile ? t('Git 仓库与代码目录不同，请在对应目录打开文件。') : undefined}
              onClick={() => onOpen(path)}
            >
              <ArrowUpRight size={14} />
              {t('打开文件')}
            </Button>
          )}
        </header>
        {error ? (
          <p role="alert">{translateError(error)}</p>
        ) : loading ? (
          <p>{t('正在读取…')}</p>
        ) : !changes.length ? (
          <p>{t('工作区干净，没有未提交变更。')}</p>
        ) : patch ? (
          <div className="sf-diff-scroll">
            <div className="sf-diff-labels">
              <span>HEAD</span>
              <span>{t('工作区')}</span>
            </div>
            <table aria-label={t('文件版本差异')}>
              <tbody>
                {splitPatch(patch).map((row, i) => (
                  <tr key={i} className={'sf-diff-' + row.kind}>
                    <td className="sf-diff-number">{row.oldNumber}</td>
                    <td
                      className={
                        row.kind === 'change' && row.oldText !== undefined ? 'is-removed' : ''
                      }
                    >
                      <pre>{row.oldText}</pre>
                    </td>
                    <td className="sf-diff-number">{row.newNumber}</td>
                    <td
                      className={
                        row.kind === 'change' && row.newText !== undefined ? 'is-added' : ''
                      }
                    >
                      <pre>{row.newText}</pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!splitPatch(patch).length && <pre>{patch}</pre>}
          </div>
        ) : (
          <p>{t('暂无文本差异')}</p>
        )}
      </section>
    </div>
  );
}
