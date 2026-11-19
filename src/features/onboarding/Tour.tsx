import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { isTauri } from '@tauri-apps/api/core';
import { Button } from '../../components/primitives';
import { t } from '../../i18n';
import { browserLayout } from '../../platform/browser-pane';
import './tour.css';

export type TourStep = {
  /** The element to light up; without one the card sits in the middle. */
  target?: string;
  title: string;
  body: string;
  content?: ReactNode;
};

const GAP = 12;
const PAD = 6;

type Box = { top: number; left: number; width: number; height: number };
const same = (a: Box | null, b: Box | null) =>
  a === b ||
  (!!a &&
    !!b &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5);

/** Next to the lit element where the card fits: below, above, right, then left. */
function place(target: Box | null, card: { width: number; height: number }) {
  const vw = window.innerWidth,
    vh = window.innerHeight;
  const clampX = (x: number) => Math.min(Math.max(x, GAP), vw - card.width - GAP);
  const clampY = (y: number) => Math.min(Math.max(y, GAP), vh - card.height - GAP);
  if (!target) return { top: (vh - card.height) / 2, left: (vw - card.width) / 2 };
  const centerX = target.left + target.width / 2 - card.width / 2;
  const centerY = target.top + target.height / 2 - card.height / 2;
  if (target.top + target.height + PAD + GAP + card.height < vh)
    return { top: target.top + target.height + PAD + GAP, left: clampX(centerX) };
  if (target.top - PAD - GAP - card.height > 0)
    return { top: target.top - PAD - GAP - card.height, left: clampX(centerX) };
  if (target.left + target.width + PAD + GAP + card.width < vw)
    return { top: clampY(centerY), left: target.left + target.width + PAD + GAP };
  return { top: clampY(centerY), left: clampX(target.left - PAD - GAP - card.width) };
}

/**
 * A guided look at the window: each step dims everything but one control and
 * says what it is for in a sentence. Steps whose control is not on screen are
 * left out. Escape skips; arrow keys and Enter move.
 */
export function Tour({
  steps,
  label,
  onFinish,
}: {
  steps: TourStep[];
  label: string;
  /** `true` when the last step was reached, `false` when skipped. */
  onFinish(completed: boolean): void;
}) {
  // Decided once the window around the tour is on screen.
  const [shown, setShown] = useState<TourStep[] | null>(null);
  useLayoutEffect(() => {
    setShown(steps.filter((step) => !step.target || document.querySelector(step.target)));
    // The steps are fixed for one run of the tour.
  }, []);
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState<Box | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const step = shown?.[index];
  const last = !!shown && index === shown.length - 1;
  const finish = useRef(onFinish);
  finish.current = onFinish;
  useEffect(() => {
    if (!shown) return;
    if (!shown.length) finish.current(true);
    // The embedded browser draws above the page; it steps aside like it does for dialogs.
    if (isTauri()) void browserLayout({ op: 'hideAll' }).catch(() => {});
  }, [shown]);
  useLayoutEffect(() => {
    if (!step) return;
    let current: Box | null = null;
    const measure = () => {
      const element = step.target ? document.querySelector(step.target) : null;
      const rect = element?.getBoundingClientRect();
      const next =
        rect && rect.width + rect.height > 0
          ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
          : null;
      if (!same(next, current)) {
        current = next;
        setTarget(next);
      }
    };
    measure();
    // Panels slide and fonts settle; follow the control while the step is up.
    const timer = setInterval(measure, 250);
    window.addEventListener('resize', measure);
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', measure);
    };
  }, [step]);
  useLayoutEffect(() => {
    if (!card.current) return;
    setPosition(place(target, card.current.getBoundingClientRect()));
  }, [target, step]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish.current(false);
      } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
        event.preventDefault();
        if (last) finish.current(true);
        else setIndex((n) => n + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setIndex((n) => Math.max(0, n - 1));
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [last]);
  if (!step || !shown) return null;
  return createPortal(
    <div className="sf-tour" role="dialog" aria-modal="true" aria-label={label}>
      {target ? (
        <div
          className="sf-tour-spot"
          style={{
            top: target.top - PAD,
            left: target.left - PAD,
            width: target.width + PAD * 2,
            height: target.height + PAD * 2,
          }}
        />
      ) : (
        <div className="sf-tour-dim" />
      )}
      <div
        ref={card}
        className={`sf-tour-card${target ? '' : ' is-centered'}`}
        style={
          (position
            ? { top: position.top, left: position.left }
            : { visibility: 'hidden' }) as CSSProperties
        }
        aria-live="polite"
      >
        {shown.length > 1 ? (
          <span
            className="sf-tour-progress"
            aria-label={t('第 {n} 步，共 {total} 步', { n: index + 1, total: shown.length })}
          >
            {shown.map((each, n) => (
              <span key={each.title} className={n === index ? 'is-current' : undefined} />
            ))}
          </span>
        ) : null}
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        {step.content}
        <footer>
          {!last ? (
            <Button variant="ghost" onClick={() => finish.current(false)}>
              {t('跳过')}
            </Button>
          ) : null}
          <span className="sf-tour-spacer" />
          {index > 0 ? <Button onClick={() => setIndex((n) => n - 1)}>{t('上一步')}</Button> : null}
          <Button
            variant="primary"
            autoFocus
            onClick={() => (last ? finish.current(true) : setIndex((n) => n + 1))}
          >
            {last ? t('开始使用') : t('下一步')}
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
