import { afterEach, expect, it, vi } from 'vitest';
import { CrossfadeController } from './view-transition';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const painted = new Map<HTMLElement, number>();
  const originalStyle = getComputedStyle;
  vi.stubGlobal(
    'getComputedStyle',
    (element: HTMLElement) =>
      new Proxy(originalStyle(element), {
        get(target, key) {
          return key === 'opacity' ? String(painted.get(element) ?? 1) : Reflect.get(target, key);
        },
      }),
  );
  const animations: { layer: HTMLElement; frames: Keyframe[]; finish(): void; cancel(): void }[] =
    [];
  const layers = ['a', 'b', 'c'].map(() => {
    const layer = document.createElement('div');
    layer.hidden = true;
    layer.animate = vi.fn((frames: Keyframe[]) => {
      let finish!: () => void;
      let cancel!: () => void;
      const finished = new Promise<void>((resolve, reject) => {
        finish = resolve;
        cancel = () => {
          painted.delete(layer);
          reject(new Error('cancelled'));
        };
      });
      const animation = { layer, frames, finish, cancel };
      animations.push(animation);
      painted.set(layer, Number(frames[0].opacity));
      return { finished, cancel } as unknown as Animation;
    }) as HTMLElement['animate'];
    document.body.append(layer);
    return layer;
  });
  const settled = vi.fn();
  const controller = new CrossfadeController(settled);
  return { controller, layers, animations, painted, settled };
}

it('crossfades above an opaque backing and continues from the painted alpha on reversals', async () => {
  const {
    controller,
    layers: [a, b, c],
    animations,
    painted,
  } = fixture();
  controller.show(a);
  controller.show(b);
  expect(a.hidden).toBe(false);
  expect(a.inert).toBe(true);
  expect(b.inert).toBe(false);
  expect(animations.map((animation) => animation.frames.map((frame) => frame.opacity))).toEqual([
    [1, 1],
    [0, 1],
  ]);
  const order = b.style.zIndex;
  painted.set(b, 0.35);
  controller.show(a);
  expect(b.style.zIndex).toBe(order);
  expect(animations.at(-1)?.frames).toEqual([{ opacity: 0.35 }, { opacity: 0 }]);
  painted.set(b, 0.2);
  controller.show(c);
  expect(animations.at(-2)?.frames).toEqual([{ opacity: 0.2 }, { opacity: 0.2 }]);
  expect(Number(c.style.zIndex)).toBeGreaterThan(Number(order));
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    let remaining = 1;
    for (const layer of [c, b, a]) {
      const frames = animations.filter((animation) => animation.layer === layer).at(-1)!.frames;
      const alpha =
        Number(frames[0].opacity) +
        (Number(frames[1].opacity) - Number(frames[0].opacity)) * progress;
      remaining *= 1 - alpha;
    }
    expect(remaining).toBe(0);
  }
  animations.forEach((animation) => animation.finish());
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(c.hidden).toBe(false);
  expect(a.hidden).toBe(true);
  expect(b.hidden).toBe(true);
  expect(c.style.willChange).toBe('');
  expect(document.querySelector('[data-native-overlay]')).toBeNull();
  controller.dispose();
});

it('keeps only the latest destination interactive after rapid navigation and cancellation', async () => {
  const { controller, layers, animations } = fixture();
  controller.show(layers[0]);
  for (let index = 0; index < 20; index++) controller.show(layers[(index + 1) % 3]);
  animations.forEach((animation) => animation.finish());
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(layers.filter((layer) => !layer.hidden)).toEqual([layers[2]]);
  expect(layers.filter((layer) => !layer.inert)).toEqual([layers[2]]);
  controller.dispose();
});

it('settles immediately with reduced motion or a missing animation API', () => {
  const {
    controller,
    layers: [a, b, c],
    animations,
  } = fixture();
  controller.show(a);
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  controller.show(b);
  expect(a.hidden).toBe(true);
  expect(b.hidden).toBe(false);
  expect(animations).toHaveLength(0);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  c.animate = undefined as unknown as HTMLElement['animate'];
  controller.show(c);
  expect(b.hidden).toBe(true);
  expect(c.hidden).toBe(false);
  controller.dispose();
});
