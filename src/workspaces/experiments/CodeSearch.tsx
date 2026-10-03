import { useEffect, useRef, useState } from 'react';
import { SearchQuery } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import {
  CaseSensitive,
  FileText,
  LoaderCircle,
  Regex,
  Search,
  Square,
  WholeWord,
} from 'lucide-react';
import { Button, Input } from '../../components/primitives';
import { getFileRuntime } from '../../editor/sessions';
import type { ResearchBackend } from '../../platform/research';
import { t, translateError } from '../../i18n';
import { describeError } from './runtime';

export type SearchHit = { path: string; from: number; to: number; line: number; preview: string };
export function fileMatches(
  content: string,
  path: string,
  query: SearchQuery,
  limit = 200,
): SearchHit[] {
  const doc = EditorState.create({ doc: content }).doc;
  const cursor = query.getCursor(doc);
  const hits: SearchHit[] = [];
  for (let match = cursor.next(); !match.done && hits.length < limit; match = cursor.next()) {
    const line = doc.lineAt(match.value.from);
    hits.push({
      path,
      from: match.value.from,
      to: match.value.to,
      line: line.number,
      preview: line.text.slice(
        Math.max(0, match.value.from - line.from - 60),
        Math.max(0, match.value.from - line.from - 60) + 180,
      ),
    });
  }
  return hits;
}
const binary =
  /\.(pdf|png|jpe?g|gif|webp|ico|zip|gz|tar|exe|dll|pyc|pkl|pt|pth|npy|npz|parquet|woff2?|ttf|mp[34]|sqlite|db)$/i;
export function CodeSearch({
  projectId,
  root,
  backend,
  onOpen,
  active,
}: {
  projectId: string;
  root?: string;
  backend: ResearchBackend;
  onOpen(hit: SearchHit): void;
  active?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [limited, setLimited] = useState(false);
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (active) input.current?.focus();
  }, [active]);
  useEffect(() => {
    setBusy(false);
    setHits([]);
    setSearched(false);
    setSkipped(0);
    setLimited(false);
    setError('');
    return () => {
      generation.current++;
    };
  }, [projectId, root, backend]);
  function stop() {
    generation.current++;
    setBusy(false);
  }
  async function find() {
    const search = new SearchQuery({
      search: query,
      caseSensitive,
      wholeWord,
      regexp,
      literal: true,
    });
    if (!search.valid) {
      setError(t('搜索表达式无效。'));
      return;
    }
    const ticket = ++generation.current;
    setBusy(true);
    setSearched(true);
    setError('');
    setHits([]);
    setLimited(false);
    setSkipped(0);
    try {
      const files = (await backend.listFiles(projectId, root))
        .filter((file) => file.kind === 'file' && !binary.test(file.path))
        .sort((a, b) => a.path.localeCompare(b.path));
      if (ticket !== generation.current) return;
      const selected = [];
      let bytes = 0;
      for (const file of files) {
        if (
          file.size > 2 * 1024 * 1024 ||
          selected.length >= 500 ||
          bytes + file.size > 32 * 1024 * 1024
        )
          continue;
        selected.push(file);
        bytes += file.size;
      }
      let unread = files.length - selected.length;
      let results: SearchHit[] = [];
      for (let offset = 0; offset < selected.length && results.length < 200; offset += 4) {
        const batch = await Promise.allSettled(
          selected.slice(offset, offset + 4).map(async (file) => {
            const buffer = [...getFileRuntime(backend).sessions.values()].find(
              (session) =>
                session.projectId === projectId &&
                session.path === file.path &&
                (session.workspaceRoot ?? '') === (root ?? '') &&
                session.getSnapshot().dirty,
            );
            const content =
              buffer?.getSnapshot().content ??
              (await backend.readFile(projectId, file.path, root)).content;
            return fileMatches(content, file.path, search);
          }),
        );
        if (ticket !== generation.current) return;
        for (const result of batch) {
          if (result.status === 'fulfilled') results = results.concat(result.value).slice(0, 200);
          else unread++;
        }
        setHits(results);
        setSkipped(unread);
        setLimited(results.length >= 200 || files.length > selected.length);
      }
      setSkipped(unread);
      setLimited(results.length >= 200 || files.length > selected.length);
    } catch (e) {
      if (ticket === generation.current) setError(describeError(e));
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  }
  return (
    <div className="sf-code-search">
      <header className="sf-resource-heading">
        <span>{t('搜索')}</span>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void find();
        }}
      >
        <div className="sf-code-search-query">
          <Input
            ref={input}
            aria-label={t('搜索工作区内容')}
            maxLength={1000}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={busy}
          />
          <Button
            type={busy ? 'button' : 'submit'}
            variant="ghost"
            iconOnly
            aria-label={t(busy ? '停止搜索' : '搜索')}
            disabled={!busy && !query}
            onClick={busy ? stop : undefined}
          >
            {busy ? <Square size={14} /> : <Search size={14} />}
          </Button>
        </div>
        <div className="sf-code-search-options">
          {[
            {
              icon: CaseSensitive,
              label: '区分大小写',
              value: caseSensitive,
              set: setCaseSensitive,
            },
            { icon: WholeWord, label: '全字匹配', value: wholeWord, set: setWholeWord },
            { icon: Regex, label: '正则表达式', value: regexp, set: setRegexp },
          ].map(({ icon: Icon, label, value, set }) => (
            <Button
              key={label}
              type="button"
              variant="ghost"
              iconOnly
              aria-label={t(label)}
              aria-pressed={value}
              disabled={busy}
              onClick={() => set(!value)}
            >
              <Icon size={15} />
            </Button>
          ))}
        </div>
      </form>
      {error && <p role="alert">{translateError(error)}</p>}
      <div className="sf-code-search-status" role="status">
        {busy && <LoaderCircle size={13} className="sf-ai-spinner" />}
        {searched && t('{count} 个匹配', { count: hits.length })}
        {limited && <span>{t('搜索达到上限')}</span>}
        {skipped > 0 && <span>{t('{count} 个文件未读取', { count: skipped })}</span>}
      </div>
      <div className="sf-code-search-results">
        {hits.map((hit) => (
          <Button
            key={`${hit.path}:${hit.from}`}
            variant="ghost"
            title={`${hit.path}:${hit.line}`}
            onClick={() => onOpen(hit)}
          >
            <span>
              <FileText size={13} />
              <strong>{hit.path}</strong>
              <small>{hit.line}</small>
            </span>
            <code>{hit.preview}</code>
          </Button>
        ))}
        {searched && !busy && !hits.length && !error && <p>{t('没有匹配的内容')}</p>}
      </div>
    </div>
  );
}
