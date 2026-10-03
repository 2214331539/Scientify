import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { listen } from '@tauri-apps/api/event';
import { Columns2, Plus, Square, Trash2 } from 'lucide-react';
import { Button, Dropdown } from '../../components/primitives';
import { t } from '../../i18n';
import { developmentApi, developmentStore, openTerminal, type TerminalInfo } from './development';
import { describeError } from './runtime';
import '@xterm/xterm/css/xterm.css';
import './development.css';

type Controller = {
  terminal: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  offset: number;
  stop(): void;
  resize(): void;
};
const controllers = new Map<string, Controller>();
function controller(info: TerminalInfo, onError: (error: string) => void) {
  const existing = controllers.get(info.id);
  if (existing) return existing;
  const element = document.createElement('div');
  element.className = 'sf-terminal-canvas';
  const terminal = new Terminal({
    fontSize: 13,
    fontFamily: 'Consolas, monospace',
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);
  let alive = true,
    polling = false,
    pending = false;
  let timer: ReturnType<typeof setTimeout>;
  let stopEvent: (() => void) | undefined;
  const value: Controller = {
    terminal,
    fit,
    element,
    offset: 0,
    stop() {
      alive = false;
      clearTimeout(timer);
      stopEvent?.();
      input.dispose();
      terminal.dispose();
    },
    resize() {
      if (!element.isConnected || element.clientWidth < 40 || element.clientHeight < 40) return;
      fit.fit();
      void developmentApi
        .terminal(info.project, {
          action: 'resize',
          id: info.id,
          cols: terminal.cols,
          rows: terminal.rows,
        })
        .catch((e) => onError(describeError(e)));
    },
  };
  const input = terminal.onData((data) => {
    void developmentApi
      .terminal(info.project, { action: 'input', id: info.id, data })
      .catch((e) => onError(describeError(e)));
  });
  async function poll() {
    if (polling) {
      pending = true;
      return;
    }
    polling = true;
    clearTimeout(timer);
    try {
      const result = await developmentApi.terminal<{
        data: string;
        offset: number;
        end: number;
        truncated: boolean;
        done: boolean;
      }>(info.project, { action: 'read', id: info.id, offset: value.offset });
      if (!alive) return;
      if (result.truncated) {
        terminal.reset();
        terminal.writeln(t('较早的终端输出已截断。'));
      }
      if (result.data) {
        const bytes = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0));
        await new Promise<void>((resolve) => terminal.write(bytes, resolve));
      }
      value.offset = result.offset;
      if (result.offset < result.end) pending = true;
      else if (result.done) {
        alive = false;
        stopEvent?.();
        terminal.options.disableStdin = true;
      }
    } catch (reason) {
      if (alive) onError(describeError(reason));
    } finally {
      polling = false;
      if (alive) timer = setTimeout(() => void poll(), pending ? 0 : 500);
      pending = false;
    }
  }
  void listen<{ id: string }>('terminal-event', ({ payload }) => {
    if (payload.id === info.id && alive) {
      clearTimeout(timer);
      void poll();
    }
  })
    .then((stop) => {
      if (alive) stopEvent = stop;
      else stop();
    })
    .catch(() => {});
  controllers.set(info.id, value);
  void poll();
  return value;
}
function TerminalSurface({ info, onError }: { info: TerminalInfo; onError(error: string): void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = controller(info, onError);
    host.current?.append(view.element);
    const theme = () => {
      const css = getComputedStyle(document.documentElement);
      view.terminal.options.theme = {
        background: css.getPropertyValue('--sf-surface-canvas').trim() || '#fff',
        foreground: css.getPropertyValue('--sf-text-primary').trim() || '#202020',
        cursor: css.getPropertyValue('--sf-text-primary').trim() || '#202020',
      };
      view.resize();
    };
    const size = new ResizeObserver(() => view.resize());
    if (host.current) size.observe(host.current);
    const style = new MutationObserver(theme);
    style.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style'],
    });
    theme();
    view.terminal.focus();
    return () => {
      size.disconnect();
      style.disconnect();
      view.element.remove();
    };
  }, [info.id]);
  return <div className="sf-terminal-surface" ref={host} aria-label={info.name} />;
}
export function TerminalPanel({
  projectId,
  experimentId,
  terminals,
  activeId,
  onActive,
  onError,
}: {
  projectId: string;
  experimentId: string;
  terminals: TerminalInfo[];
  activeId: string;
  onActive(id: string): void;
  onError(error: string): void;
}) {
  useEffect(() => {
    const known = new Set(developmentStore.getState().terminals.map((item) => item.id));
    for (const [id, view] of controllers) {
      if (!known.has(id)) {
        view.stop();
        controllers.delete(id);
      }
    }
  }, [terminals]);
  const [profile, setProfile] = useState(
    navigator.platform.toLowerCase().includes('win') ? 'powershell' : 'bash',
  );
  const [busy, setBusy] = useState(false);
  const [splitId, setSplitId] = useState('');
  const current = terminals.find((info) => info.id === activeId) ?? terminals.at(-1);
  const split = terminals.find((info) => info.id === splitId && info.id !== current?.id);
  async function create(split = false) {
    setBusy(true);
    try {
      const info = await openTerminal(projectId, experimentId, profile);
      if (info) {
        if (split && current) setSplitId(current.id);
        onActive(info.id);
      }
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  async function close(info: TerminalInfo) {
    try {
      await developmentApi.terminal(projectId, { action: 'close', id: info.id });
      controllers.get(info.id)?.stop();
      controllers.delete(info.id);
      developmentStore.setState((data) => ({
        terminals: data.terminals.filter((item) => item.id !== info.id),
      }));
    } catch (e) {
      onError(describeError(e));
    }
  }
  return (
    <section className="sf-terminal-panel" aria-label={t('终端')}>
      <header className="sf-terminal-toolbar">
        <div className="sf-terminal-tabs" role="tablist" aria-label={t('终端会话')}>
          {terminals.map((info, index) => (
            <Button
              key={info.id}
              role="tab"
              variant="ghost"
              aria-selected={current?.id === info.id}
              onClick={() => onActive(info.id)}
              title={info.environment?.executable || info.root}
            >
              {info.name} {index + 1}
              {info.status !== 'running' ? ` (${info.exitCode ?? '—'})` : ''}
            </Button>
          ))}
        </div>
        <Dropdown
          value={profile}
          aria-label={t('终端类型')}
          onChange={(event) => setProfile(event.target.value)}
        >
          <option value="powershell">PowerShell</option>
          <option value="pwsh">PowerShell 7</option>
          <option value="cmd">Command Prompt</option>
          <option value="python">Python REPL</option>
          {!navigator.platform.toLowerCase().includes('win') && <option value="bash">bash</option>}
        </Dropdown>
        <Button
          variant="ghost"
          iconOnly
          tooltip={t('新建终端')}
          aria-label={t('新建终端')}
          disabled={busy || !developmentApi.available()}
          onClick={() => void create()}
        >
          <Plus size={15} />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          tooltip={t('拆分终端')}
          aria-label={t('拆分终端')}
          disabled={busy || !developmentApi.available()}
          onClick={() => (split ? setSplitId('') : void create(true))}
        >
          <Columns2 size={15} />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          tooltip={t('中断命令')}
          aria-label={t('中断命令')}
          disabled={current?.status !== 'running'}
          onClick={() => {
            if (current)
              void developmentApi
                .terminal(projectId, { action: 'input', id: current.id, data: '\x03' })
                .catch((e) => onError(describeError(e)));
          }}
        >
          <Square size={14} />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          tooltip={t('终止终端')}
          aria-label={t('终止终端')}
          disabled={!current}
          onClick={() => current && void close(current)}
        >
          <Trash2 size={15} />
        </Button>
      </header>
      <div className={'sf-terminal-panes' + (split ? ' is-split' : '')}>
        {split && <TerminalSurface info={split} onError={onError} />}
        {current ? (
          <TerminalSurface key={current.id} info={current} onError={onError} />
        ) : (
          <div className="sf-terminal-empty">
            <Button disabled={busy || !developmentApi.available()} onClick={() => void create()}>
              <Plus size={15} />
              {t('新建终端')}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
