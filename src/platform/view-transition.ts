/** Animate committed chrome, without a document snapshot or an input-blocking overlay. */
export function animateWorkspaceNavigation(surface: HTMLElement | null) {
  if (!surface || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const style = getComputedStyle(surface);
  const duration = parseFloat(style.getPropertyValue('--sf-motion-content')) || 160;
  const easing = style.getPropertyValue('--sf-ease-enter').trim() || 'ease-out';
  const targets = surface.querySelectorAll<HTMLElement>(
    '.workspace-commandbar, .sf-panel-header, .research-home-project, .sf-experiment-manager-toolbar, .library-root-toolbar',
  );
  const animations = [...targets].flatMap((target) =>
    typeof target.animate === 'function'
      ? [target.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration, easing })]
      : [],
  );
  return () => animations.forEach((animation) => animation.cancel());
}
