type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

/**
 * Runs a small native view transition when the embedded Chromium supports it.
 * The fallback is immediate so navigation never waits for decorative motion.
 */
export function runViewTransition(update: () => void) {
  if (
    typeof document === 'undefined' ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  ) {
    update();
    return;
  }
  const start = (document as ViewTransitionDocument).startViewTransition;
  if (!start) {
    update();
    return;
  }
  try {
    const transition = start.call(document, update);
    void transition.finished.catch(() => {
      /* A cancelled transition has no effect on the committed UI state. */
    });
  } catch {
    update();
  }
}
