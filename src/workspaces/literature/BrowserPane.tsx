import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, X } from 'lucide-react';
import { Button, Input } from '../../components/primitives';
import {
  browserCommand,
  browserEvents,
  browserLayout,
  DEFAULT_BROWSER_URL,
  type BrowserTab,
} from '../../platform/browser-pane';
import { t, translateError } from '../../i18n';

export function BrowserPane({
  id,
  initialUrl,
  onChanged,
}: {
  id: string;
  initialUrl?: string;
  onChanged: (tab: BrowserTab) => void;
}) {
  const [tab, setTab] = useState<BrowserTab | null>(null),
    [address, setAddress] = useState(DEFAULT_BROWSER_URL),
    [error, setError] = useState('');
  const canvas = useRef<HTMLDivElement>(null),
    callback = useRef(onChanged);
  const editing = useRef(false);
  const currentTab = useRef(tab);
  currentTab.current = tab;
  const syncLayout = useRef<(() => void) | null>(null);
  callback.current = onChanged;
  useEffect(() => {
    let active = true;
    const receive = (next: BrowserTab) => {
      if (!active || next.id !== id) return;
      setTab(next);
      if (!editing.current) setAddress(next.url);
      callback.current(next);
    };
    const sub = browserEvents('browser-changed', receive);
    void browserCommand<BrowserTab[]>({ op: 'snapshot' })
      .then((tabs) => {
        if (!active) return;
        const t = tabs.find((t) => t.id === id);
        if (t) {
          receive(t);
          const firstAddress = initialUrl?.trim() || DEFAULT_BROWSER_URL;
          if (!t.url)
            void browserCommand<BrowserTab>({ op: 'navigate', id, address: firstAddress })
              .then(receive)
              .catch((e) => setError(String(e)));
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      active = false;
      void sub.then((stop) => stop());
      void browserLayout({ op: 'hideAll' }).catch(() => {});
    };
  }, [id]);
  useEffect(() => {
    const host = canvas.current;
    if (!host) return;
    let disposed = false,
      frame = 0;
    const sync = () => {
      if (disposed) return;
      const r = host.getBoundingClientRect();
      const overlay = !!document.querySelector('dialog[open], [data-native-overlay="true"]');
      void browserLayout({
        op: 'layout',
        id,
        bounds: {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          // Keep the native page visible when navigation reports an error. WebView2
          // can still have a useful provider error/CAPTCHA page (for example
          // Google's `sorry` page) that the user needs to inspect or retry.
          visible: !overlay && !document.hidden && !!currentTab.current?.url,
        },
      }).catch((e) => {
        if (!disposed) setError(String(e));
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sync);
    };
    syncLayout.current = schedule;
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'data-native-overlay'],
    });
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', schedule);
    sync();
    return () => {
      disposed = true;
      syncLayout.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
      void browserLayout({ op: 'hideAll' }).catch(() => {});
    };
  }, [id]);
  useEffect(() => {
    syncLayout.current?.();
  }, [tab?.url, tab?.error, error]);
  async function action(action: string) {
    setError('');
    try {
      await browserCommand({ op: 'action', id, action });
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div className="browser-pane">
      <form
        className="browser-address"
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          try {
            const next = await browserCommand<BrowserTab>({ op: 'navigate', id, address });
            setTab(next);
            setAddress(next.url);
            editing.current = false;
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        <Button
          type="button"
          variant="ghost"
          iconOnly
          aria-label={t('后退')}
          disabled={!tab?.canBack}
          onClick={() => void action('back')}
        >
          <ArrowLeft />
        </Button>
        <Button
          type="button"
          variant="ghost"
          iconOnly
          aria-label={t('前进')}
          disabled={!tab?.canForward}
          onClick={() => void action('forward')}
        >
          <ArrowRight />
        </Button>
        <Button
          type="button"
          variant="ghost"
          iconOnly
          aria-label={tab?.loading ? t('停止') : t('刷新')}
          disabled={!tab?.url}
          onClick={() => void action(tab?.loading ? 'stop' : 'reload')}
        >
          {tab?.loading ? <X /> : <RotateCw />}
        </Button>
        <Input
          aria-label={t('网址或搜索词')}
          placeholder={t('输入网址或搜索词')}
          value={address}
          onFocus={() => {
            editing.current = true;
          }}
          onBlur={() => {
            editing.current = false;
          }}
          onChange={(e) => setAddress(e.target.value)}
        />
        <Button type="submit">{t('打开')}</Button>
        <Button
          type="button"
          variant="ghost"
          iconOnly
          aria-label={t('在系统浏览器打开')}
          disabled={!address.trim()}
          onClick={() =>
            void browserCommand({ op: 'external', address }).catch((e) => setError(String(e)))
          }
        >
          <ExternalLink />
        </Button>
      </form>
      {(error || tab?.error) && (
        <div role="alert" className="inline-error">
          {translateError(error || tab?.error)}
        </div>
      )}
      <div ref={canvas} className="browser-canvas">
        {!tab?.url && <span>{t('输入网址或搜索词')}</span>}
        {tab?.loading && <span role="status">{t('正在读取…')}</span>}
      </div>
    </div>
  );
}
