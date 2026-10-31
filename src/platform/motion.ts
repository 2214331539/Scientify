export const motion = {
  feedback: 140,
  content: 220,
  navigation: 320,
  selection: 220,
  overlay: 220,
  panel: 240,
  exit: 180,
  layout: 320,
  easing: 'cubic-bezier(0.42, 0, 0.58, 1)',
} as const;

export function applyMotion(root: HTMLElement) {
  for (const [scene, duration] of Object.entries(motion)) {
    if (typeof duration === 'number')
      root.style.setProperty(`--sf-motion-${scene}`, `${duration}ms`);
  }
  for (const name of ['standard', 'enter', 'exit', 'apple'])
    root.style.setProperty(`--sf-ease-${name}`, motion.easing);
}

export function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
