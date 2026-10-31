import { motion, reducedMotion } from './motion';

/** Retains the painted composite until the latest navigation finishes. */
export class CrossfadeController {
  private animations = new Map<HTMLElement, Animation>();
  private visible = new Set<HTMLElement>();
  private revision = 0;
  private target: HTMLElement | null = null;

  constructor(private settled: () => void = () => {}) {}

  private cancel() {
    for (const animation of this.animations.values()) animation.cancel();
    this.animations.clear();
  }

  settle() {
    ++this.revision;
    this.cancel();
    for (const layer of this.visible) {
      layer.hidden = layer !== this.target;
      layer.style.removeProperty('z-index');
      layer.style.removeProperty('will-change');
      delete layer.dataset.nativeOverlay;
    }
    this.visible = this.target ? new Set([this.target]) : new Set();
    this.settled();
  }

  show(incoming: HTMLElement) {
    if (incoming === this.target) return;
    const first = !this.target;
    this.target = incoming;
    const starts = new Map(
      [...this.visible].map((layer) => [
        layer,
        {
          opacity: Number(getComputedStyle(layer).opacity || 1),
          order: Number(layer.style.zIndex),
        },
      ]),
    );
    const order =
      starts.get(incoming)?.order ??
      Math.max(0, ...[...starts.values()].map((start) => start.order)) + 1;
    this.cancel();
    this.visible.add(incoming);
    for (const layer of this.visible) {
      layer.hidden = false;
      layer.inert = layer !== incoming;
      layer.setAttribute('aria-hidden', String(layer !== incoming));
    }
    if (first || reducedMotion() || typeof incoming.animate !== 'function') {
      this.settle();
      return;
    }
    const revision = ++this.revision;
    const jobs = [...this.visible].map((layer) => {
      const start = starts.get(layer) ?? { opacity: 0, order };
      layer.style.zIndex = String(start.order);
      layer.style.willChange = 'opacity';
      layer.dataset.nativeOverlay = 'true';
      const animation = layer.animate(
        [
          { opacity: start.opacity },
          { opacity: layer === incoming ? 1 : start.order > order ? 0 : start.opacity },
        ],
        { duration: motion.navigation, easing: motion.easing, fill: 'both' },
      );
      this.animations.set(layer, animation);
      return animation.finished.catch(() => {});
    });
    void Promise.all(jobs).then(() => {
      if (revision === this.revision) this.settle();
    });
  }

  dispose() {
    ++this.revision;
    this.cancel();
    for (const layer of this.visible) {
      layer.style.removeProperty('z-index');
      layer.style.removeProperty('will-change');
      delete layer.dataset.nativeOverlay;
    }
    this.visible.clear();
    this.target = null;
  }
}
