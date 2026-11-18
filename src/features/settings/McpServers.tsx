import { useState } from 'react';
import { useStore } from 'zustand';
import { Plus, Trash } from 'lucide-react';
import { Button, Input, Textarea } from '../../components/primitives';
import { t } from '../../i18n';
import type { WorkspaceStore } from '../../stores/workspace';

/** An MCP server the Agent may use: a command it starts, or one it reaches by URL. */
export type McpServer = {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
};

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
// One empty list, so the store selector returns the same value each time.
const NONE: McpServer[] = [];

/** "KEY=value" lines as an object; other lines are left out. */
export function parseEnv(text: string) {
  return Object.fromEntries(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z0-9_-]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

type Draft = {
  name: string;
  kind: 'command' | 'url';
  command: string;
  args: string;
  env: string;
  url: string;
};
const empty: Draft = { name: '', kind: 'command', command: '', args: '', env: '', url: '' };

/**
 * Settings → AI: MCP servers, the tools the Agent gets beyond Scientify's own
 * (Zotero, a database, a company wiki…), like ChatGPT's connectors.
 */
export function McpServers({ store }: { store: WorkspaceStore }) {
  const servers = useStore(store, (state) => {
    const value = state.data?.settings.mcpServers;
    return Array.isArray(value) ? (value as McpServer[]) : NONE;
  });
  const busy = useStore(store, (state) => state.busy);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const save = (next: McpServer[]) =>
    store.getState().update((workspace) => {
      workspace.settings.mcpServers = next;
    });
  async function add() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!NAME.test(name)) return setError(t('名称只能用英文字母、数字、- 和 _。'));
    if (servers.some((server) => server.name === name)) return setError(t('已经有同名的服务。'));
    const server: McpServer =
      draft.kind === 'url'
        ? { name, url: draft.url.trim(), enabled: true }
        : {
            name,
            command: draft.command.trim(),
            args: draft.args
              .split('\n')
              .map((arg) => arg.trim())
              .filter(Boolean),
            env: parseEnv(draft.env),
            enabled: true,
          };
    if (draft.kind === 'url' ? !/^https?:\/\//.test(server.url ?? '') : !server.command)
      return setError(draft.kind === 'url' ? t('请填写服务网址。') : t('请填写启动命令。'));
    if (await save([...servers, server])) {
      setDraft(null);
      setError('');
    }
  }
  const field = (key: keyof Draft, value: string) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  return (
    <div className="settings-instructions">
      <h3>{t('MCP 工具')}</h3>
      <p className="muted">
        {t('接入 MCP 服务后，AI 能用它们提供的工具，例如读 Zotero、查数据库。对新任务生效。')}
      </p>
      {servers.length ? (
        <ul className="settings-mcp-list">
          {servers.map((server) => (
            <li key={server.name}>
              <label>
                <input
                  type="checkbox"
                  checked={server.enabled !== false}
                  disabled={busy}
                  onChange={(event) =>
                    void save(
                      servers.map((item) =>
                        item.name === server.name
                          ? { ...item, enabled: event.target.checked }
                          : item,
                      ),
                    )
                  }
                />
                <b>{server.name}</b>
              </label>
              <code>
                {server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')}
              </code>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={t('删除 {name}', { name: server.name })}
                disabled={busy}
                onClick={() => void save(servers.filter((item) => item.name !== server.name))}
              >
                <Trash size={14} />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {draft ? (
        <div className="settings-mcp-form">
          <Input
            value={draft.name}
            placeholder={t('名称，例如 zotero')}
            aria-label={t('名称')}
            onChange={(event) => field('name', event.target.value)}
          />
          <div className="sf-segmented" role="radiogroup" aria-label={t('连接方式')}>
            {(['command', 'url'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={draft.kind === kind}
                onClick={() => field('kind', kind)}
              >
                {kind === 'command' ? t('本机命令') : t('网址')}
              </button>
            ))}
          </div>
          {draft.kind === 'url' ? (
            <Input
              value={draft.url}
              placeholder="http://127.0.0.1:23119/mcp"
              aria-label={t('网址')}
              onChange={(event) => field('url', event.target.value)}
            />
          ) : (
            <>
              <Input
                value={draft.command}
                placeholder={t('启动命令，例如 npx')}
                aria-label={t('启动命令')}
                onChange={(event) => field('command', event.target.value)}
              />
              <Textarea
                rows={3}
                value={draft.args}
                placeholder={t('参数，一行一个')}
                aria-label={t('参数')}
                onChange={(event) => field('args', event.target.value)}
              />
              <Textarea
                rows={2}
                value={draft.env}
                placeholder={t('环境变量，一行一个 KEY=value')}
                aria-label={t('环境变量')}
                onChange={(event) => field('env', event.target.value)}
              />
            </>
          )}
          {error ? <p className="error-text">{error}</p> : null}
          <div className="settings-actions">
            <Button variant="ghost" onClick={() => (setDraft(null), setError(''))}>
              {t('取消')}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void add()}>
              {t('添加')}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="secondary" size="sm" onClick={() => setDraft(empty)}>
            <Plus size={14} />
            {t('添加 MCP 服务')}
          </Button>
        </div>
      )}
    </div>
  );
}
