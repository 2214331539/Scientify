import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { listen } from '@tauri-apps/api/event';
import { Columns2, Plus, Square, Trash2 } from 'lucide-react';
import { Button, Dropdown } from '../../components/primitives';
import { t } from '../../i18n';
import { displayPath } from '../../platform/os';
import { developmentApi, developmentStore, openTerminal, type TerminalInfo } from './development';
import { errorMessage } from '../../domain/errors';
import '@xterm/xterm/css/xterm.css';
import './development.css';

/**
 * The sixteen terminal colors for a light or a dark page (GitHub's, chosen to read
 * on their background). xterm's defaults assume a dark page, so on white its
 * yellow, cyan and white could not be read.
 */
const PALETTES = {
  light: {
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#7d4e00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f',
    selectionBackground: 'rgba(9, 105, 218, 0.22)',
  },
  dark: {
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
    selectionBackground: 'rgba(56, 139, 253, 0.32)',
  },
};

/** Colors for the page as it is now drawn, light or dark. */
export function terminalTheme() {
  const css = getComputedStyle(document.documentElement);
  const dark = document.documentElement.classList.contains('dark');
  const background =
    css.getPropertyValue('--sf-surface-canvas').trim() || (dark ? '#0d1117' : '#fff');
  const foreground =
    css.getPropertyValue('--sf-text-primary').trim() || (dark ? '#e6edf3' : '#1f2328');
  return {
    ...PALETTES[dark ? 'dark' : 'light'],
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
  };
}

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
    // Any program's colors stay readable on this page's background.
    minimumContrastRatio: 4.5,
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
        .catch((e) => onError(errorMessage(e)));
    },
  };
  const input = terminal.onData((data) => {
    void developmentApi
      .terminal(info.project, { action: 'input', id: info.id, data })
      .catch((e) => onError(errorMessage(e)));
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
      if (alive) onError(errorMessage(reason));
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
      view.terminal.options.theme = terminalTheme();
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
  onCreate,
}: {
  projectId: string;
  experimentId: string;
  terminals: TerminalInfo[];
  activeId: string;
  onActive(id: string): void;
  onError(error: string): void;
  /** Opens another kind of terminal, such as a shell on a cloud host; no local shell picker. */
  onCreate?: () => Promise<TerminalInfo | null>;
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
  const platform = useStore(developmentStore, (state) => state.platform);
  const [selectedProfile, setProfile] = useState('');
  const profile =
    selectedProfile ||
    (platform === 'macos' ? 'zsh' : platform === 'windows' ? 'powershell' : 'bash');
  const [busy, setBusy] = useState(false);
  const [splitId, setSplitId] = useState('');
  const current = terminals.find((info) => info.id === activeId) ?? terminals.at(-1);
  const split = terminals.find((info) => info.id === splitId && info.id !== current?.id);
  async function create(split = false) {
    setBusy(true);
    try {
      const info = onCreate
        ? await onCreate()
        : await openTerminal(projectId, experimentId, profile);
      if (info) {
        if (split && current) setSplitId(current.id);
        onActive(info.id);
      }
    } catch (e) {
      onError(errorMessage(e));
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
      onError(errorMessage(e));
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
              title={displayPath(info.environment?.executable || info.root)}
            >
              {info.name} {index + 1}
              {info.status !== 'running' ? ` (${info.exitCode ?? '—'})` : ''}
            </Button>
          ))}
        </div>
        {onCreate ? null : (
          <Dropdown
            value={profile}
            aria-label={t('终端类型')}
            onChange={(event) => setProfile(event.target.value)}
          >
            {platform === 'windows' && <option value="powershell">PowerShell</option>}
            <option value="pwsh">PowerShell 7</option>
            {platform === 'windows' && <option value="cmd">Command Prompt</option>}
            <option value="python">Python REPL</option>
            {platform === 'macos' && <option value="zsh">zsh</option>}
            {platform !== 'windows' && <option value="bash">bash</option>}
          </Dropdown>
        )}
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
                .catch((e) => onError(errorMessage(e)));
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
        {current ? <TerminalSurface key={current.id} info={current} onError={onError} /> : null}
      </div>
    </section>
  );
}
