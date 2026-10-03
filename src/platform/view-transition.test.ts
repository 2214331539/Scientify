import { afterEach, expect, it, vi } from 'vitest';
import { animateWorkspaceNavigation } from './view-transition';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('only animates committed chrome and cancels it on rapid navigation', () => {
  const surface = document.createElement('div');
  surface.innerHTML =
    '<header class="workspace-commandbar"></header><div class="cm-editor"></div><canvas></canvas><div class="xterm"></div>';
  document.body.append(surface);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
  );
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }) as unknown as Animation);
  for (const child of surface.children) (child as HTMLElement).animate = animate;
  const cleanup = animateWorkspaceNavigation(surface);
  expect(animate).toHaveBeenCalledOnce();
  expect(animate.mock.instances[0]).toBe(surface.firstElementChild);
  cleanup?.();
  expect(cancel).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

it('leaves navigation functional with reduced motion or without Web Animations', () => {
  const surface = document.createElement('div');
  surface.innerHTML = '<header class="workspace-commandbar"></header>';
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true })),
  );
  const animate = vi.fn();
  (surface.firstElementChild as HTMLElement).animate = animate;
  expect(animateWorkspaceNavigation(surface)).toBeUndefined();
  expect(animate).not.toHaveBeenCalled();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
  );
  (surface.firstElementChild as HTMLElement).animate =
    undefined as unknown as HTMLElement['animate'];
  expect(() => animateWorkspaceNavigation(surface)?.()).not.toThrow();
  vi.unstubAllGlobals();
});
