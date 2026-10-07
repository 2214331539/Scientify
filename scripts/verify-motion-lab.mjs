import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const fixture = new URL('../docs/UI-UX/示例/', import.meta.url);
const [html, icons, script] = await Promise.all(
  ['index.html', 'lucide-icons.js', 'motion-lab.js'].map((file) =>
    readFile(new URL(file, fixture), 'utf8'),
  ),
);
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://motion.fixture.test/' });
const { window } = dom;
const { document } = window;
const animations = [];
const painted = new Map();
const originalStyle = window.getComputedStyle.bind(window);
window.matchMedia = () => ({ matches: false, addEventListener() {} });
window.getComputedStyle = (element) => {
  const style = originalStyle(element);
  return new Proxy(style, {
    get(target, property) {
      if (property === 'transform') return painted.get(element)?.frame.transform || 'none';
      if (property === 'opacity') return String(painted.get(element)?.frame.opacity ?? 1);
      return Reflect.get(target, property);
    },
  });
};
window.HTMLElement.prototype.getBoundingClientRect = () => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 900,
  bottom: 600,
  width: 900,
  height: 600,
});
window.HTMLElement.prototype.animate = function (frames, options) {
  let resolve, reject;
  const animation = {
    element: this,
    frames,
    options,
    playState: 'running',
    frame: frames[0],
    finished: new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    }),
    cancel() {
      if (painted.get(this.element) === this) painted.delete(this.element);
      if (this.playState !== 'running') return;
      this.playState = 'idle';
      reject(new Error('Animation canceled'));
    },
    finish() {
      if (this.playState !== 'running') return;
      this.playState = 'finished';
      this.frame = this.frames.at(-1);
      if (this.options.fill !== 'both') painted.delete(this.element);
      resolve();
    },
  };
  painted.set(this, animation);
  animations.push(animation);
  return animation;
};
const select = (selector) => document.querySelector(selector);
const click = (selector) => select(selector).click();
const tick = () => new Promise((resolve) => setImmediate(resolve));
const finish = async () => {
  animations.filter((animation) => animation.playState === 'running').forEach((a) => a.finish());
  await tick();
};
const latest = (selector) =>
  animations.filter((animation) => animation.element === select(selector)).at(-1);
const pageLayers = () =>
  [...document.querySelectorAll('[data-page]')]
    .filter((pane) => !pane.hidden)
    .sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex));
const samplePageFade = (progress) => {
  for (const animation of animations) {
    if (animation.playState !== 'running' || !animation.element.matches('[data-page]')) continue;
    const from = animation.frames[0];
    const to = animation.frames.at(-1);
    animation.frame = {
      opacity: from.opacity + (to.opacity - from.opacity) * progress,
      transform: 'none',
    };
  }
  let remaining = 1;
  const weights = {};
  for (const pane of pageLayers()) {
    const opacity = Number(window.getComputedStyle(pane).opacity);
    weights[pane.dataset.page] = opacity * remaining;
    remaining *= 1 - opacity;
  }
  assert.ok(remaining < 1e-10, 'An opaque backing must cover the page throughout the fade');
  return weights;
};
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10);
const assertActivePage = (page) => {
  const panes = [...document.querySelectorAll('[data-page]')];
  assert.deepEqual(
    panes.filter((pane) => !pane.hidden).map((pane) => pane.dataset.page),
    [page],
  );
  for (const pane of panes) assert.equal(pane.inert, pane.dataset.page !== page);
  assert.equal(select('.page-stack').hasAttribute('data-transitioning'), false);
};

try {
  window.eval(icons);
  window.eval(script);
  assert.equal(document.documentElement.dataset.profile, 'continuous');
  const note = select('.note-editor');
  note.value = 'Keep this unsaved note';

  click('[data-action="nav:code"]');
  assert.equal(select('[data-page="literature"]').hidden, false);
  assert.equal(select('[data-page="literature"]').inert, true);
  assert.equal(select('[data-page="code"]').inert, false);
  assert.equal(select('[data-page="literature"]').getAttribute('aria-hidden'), 'true');
  for (const selector of ['[data-page="literature"]', '[data-page="code"]']) {
    const animation = latest(selector);
    assert.ok(animation.frames.every((frame) => frame.transform === 'none'));
    assert.equal(animation.options.fill, 'both');
    assert.equal(animation.options.duration, 320);
  }
  assert.deepEqual(
    Array.from(latest('[data-page="literature"]').frames, (frame) => frame.opacity),
    [1, 1],
  );
  assert.deepEqual(
    Array.from(latest('[data-page="code"]').frames, (frame) => frame.opacity),
    [0, 1],
  );
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    const weights = samplePageFade(progress);
    near(weights.literature, 1 - progress);
    near(weights.code, progress);
  }
  samplePageFade(0.35);
  const codeLayer = select('[data-page="code"]').style.zIndex;
  const literatureLayer = select('[data-page="literature"]').style.zIndex;
  click('[data-action="nav:literature"]');
  assert.equal(select('[data-page="literature"]').style.zIndex, literatureLayer);
  assert.equal(select('[data-page="code"]').style.zIndex, codeLayer);
  near(latest('[data-page="code"]').frames[0].opacity, 0.35);
  assert.equal(latest('[data-page="code"]').frames.at(-1).opacity, 0);
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    const weights = samplePageFade(progress);
    near(weights.code, 0.35 * (1 - progress));
  }
  samplePageFade(0.5);
  click('[data-action="nav:code"]');
  near(latest('[data-page="code"]').frames[0].opacity, 0.175);
  assert.equal(select('[data-page="code"]').style.zIndex, codeLayer);
  samplePageFade(0.4);
  click('[data-action="nav:notes"]');
  const middleOpacity = 0.175 + (1 - 0.175) * 0.4;
  near(latest('[data-page="code"]').frames[0].opacity, middleOpacity);
  near(latest('[data-page="code"]').frames.at(-1).opacity, middleOpacity);
  assert.ok(Number(select('[data-page="notes"]').style.zIndex) > Number(codeLayer));
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    const weights = samplePageFade(progress);
    near(weights.notes, progress);
    near(weights.code, middleOpacity * (1 - progress));
    near(weights.literature, (1 - middleOpacity) * (1 - progress));
  }
  samplePageFade(0.5);
  click('[data-action="nav:code"]');
  near(latest('[data-page="notes"]').frames[0].opacity, 0.5);
  assert.equal(latest('[data-page="notes"]').frames.at(-1).opacity, 0);
  assert.equal(select('[data-page="code"]').style.zIndex, codeLayer);
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) samplePageFade(progress);
  await finish();
  assertActivePage('code');
  const noOpCount = animations.length;
  click('[data-action="nav:code"]');
  assert.equal(animations.length, noOpCount);
  click('[data-action="nav:literature"]');
  await finish();
  assertActivePage('literature');

  for (let index = 0; index < 20; index++) {
    click(`[data-action="nav:${['code', 'notes', 'paper', 'collaboration'][index % 4]}"]`);
  }
  await finish();
  assertActivePage('collaboration');
  assert.equal(select('.resource').hidden, false);
  assert.equal(select('.note-editor'), note);
  assert.equal(note.value, 'Keep this unsaved note');

  click('[data-action="nav:notes"]');
  click('#reduced-motion');
  await tick();
  assertActivePage('notes');
  const count = animations.length;
  click('[data-action="nav:code"]');
  assertActivePage('code');
  assert.equal(animations.length, count);
  click('#reduced-motion');

  click('[data-action="assistant"]');
  latest('.assistant').frame = { opacity: 0.4, transform: 'none' };
  click('[data-action="assistant-close"]');
  assert.equal(latest('.assistant').frames[0].opacity, 0.4);
  assert.equal(latest('.assistant').frames.at(-1).opacity, 0);
  assert.equal(select('.assistant').inert, true);
  latest('.assistant').frame = { opacity: 0.2, transform: 'none' };
  click('[data-action="assistant"]');
  assert.equal(latest('.assistant').frames[0].opacity, 0.2);
  assert.equal(latest('.assistant').frames.at(-1).opacity, 1);
  await finish();
  assert.equal(select('.assistant').hidden, false);
  assert.equal(select('.assistant').inert, false);
  assert.ok(latest('.assistant').frames.every((frame) => frame.transform === 'none'));
  click('[data-action="assistant-close"]');
  await finish();
  assert.equal(select('.assistant').hidden, true);
  click('[data-action="assistant"]');
  assert.equal(latest('.assistant').frames[0].opacity, 0);
  await finish();
  assert.equal(select('.assistant').hidden, false);

  for (const profile of ['precision', 'balanced', 'expressive', 'continuous']) {
    click('[data-action="nav:notes"]');
    click(`[data-profile-choice="${profile}"]`);
    await finish();
    assertActivePage('notes');
    assert.equal(select('.note-editor'), note);
    assert.equal(note.value, 'Keep this unsaved note');
    click('[data-action="nav:code"]');
    await finish();
  }
  delete window.HTMLElement.prototype.animate;
  click('[data-action="nav:notes"]');
  await tick();
  assertActivePage('notes');
  console.log(
    'Motion lab: crossfade coverage and blending, interrupted layer continuity, rapid navigation, drafts, reduced motion, panels, A/B/C/D switching and API fallback passed.',
  );
} finally {
  dom.window.close();
}
