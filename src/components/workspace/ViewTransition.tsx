import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { CrossfadeController } from '../../platform/view-transition';
import './view-transition.css';

const ActiveView = createContext(true);
export const useActiveView = () => useContext(ActiveView);

/** One mounted instance per visited view; navigation changes visibility, not identity. */
export function ViewTransition({
  viewKey,
  children,
  className = '',
  external,
  onSettled,
}: {
  viewKey: string;
  children: ReactNode;
  className?: string;
  external?: { key: string; ref: RefObject<HTMLElement | null> };
  onSettled?: () => void;
}) {
  const parentActive = useActiveView();
  const views = useRef(new Map<string, ReactNode>());
  const layers = useRef(new Map<string, HTMLDivElement>());
  const callback = useRef(onSettled);
  callback.current = onSettled;
  const controller = useRef<CrossfadeController | null>(null);
  if (viewKey !== external?.key) views.current.set(viewKey, children);

  useLayoutEffect(() => {
    const fade = new CrossfadeController(() => callback.current?.());
    controller.current = fade;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const reduce = () => {
      if (media?.matches) fade.settle();
    };
    media?.addEventListener?.('change', reduce);
    return () => {
      media?.removeEventListener?.('change', reduce);
      fade.dispose();
      controller.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const incoming = viewKey === external?.key ? external.ref.current : layers.current.get(viewKey);
    if (incoming) controller.current?.show(incoming);
  }, [viewKey, external?.key, external?.ref]);

  return (
    <div className={`sf-view-stack ${className}`}>
      {[...views.current].map(([key, content]) => (
        <div
          key={key}
          ref={(layer) => {
            if (layer) layers.current.set(key, layer);
            else layers.current.delete(key);
          }}
          className="sf-view-layer"
          data-view-key={key}
          aria-hidden={key !== viewKey}
          inert={key !== viewKey}
        >
          <ActiveView.Provider value={parentActive && key === viewKey}>
            {content}
          </ActiveView.Provider>
        </div>
      ))}
    </div>
  );
}
