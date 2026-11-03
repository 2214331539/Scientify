// Scientify logo: an open box with one dot rising out of it.
//
//   node build.mjs            regenerate the whole kit into the folder above source/
//   node build.mjs kit <dir>  same, into another folder
//   node build.mjs preview <dir>
//
// Rasterising uses the repository's Playwright with an installed Chrome (or Edge);
// set SCIENTIFY_BROWSER_PATH to use another Chromium executable.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COLOR = {
  ink: '#111A17',
  lime: '#C6F24E',
  white: '#FFFFFF',
  tileLight: '#F7F8F6',
  tileLightEdge: '#D3D9D6',
};

// Everything is drawn on a 120-unit canvas.
const TILE = { x: 3, size: 114, radius: 25.5 };
const T30 = Math.tan(Math.PI / 6);
// Dot radius and its offset below the back corner of the box, in box half-widths.
const DOT = { r: 0.31, y: 0.09 };
// Mark height as a share of the canvas or tile.
const LAYOUT = {
  mark: { height: 0.82, box: 120 },
  taskbar: { height: 0.9, box: 120 },
  tile: { height: 0.64, box: TILE.size },
};

const num = (v) => Number(v.toFixed(2));
const pt = ([x, y]) => `${num(x)} ${num(y)}`;

function geometry(a, gap) {
  const b = a * T30;
  return { a, b, h: a * 0.96, k: 0.64, g: gap ?? a * 0.115, r: a * DOT.r, dy: -b + a * DOT.y };
}

function inConvex(points, x, y) {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const c = Math.sign((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1));
    if (c && sign && c !== sign) return false;
    if (c) sign = c;
  }
  return true;
}

// Area-weighted vertical centre of the visible shape, relative to the centre of the opening.
function visualCentre({ a, b, h, k, g, r, dy }) {
  const hex = [[-a, 0], [0, -b], [a, 0], [a, h], [0, b + h], [-a, h]];
  const open = [[-a * k, 0], [0, -b * k], [a * k, 0], [0, b * k]];
  let sum = 0;
  let count = 0;
  const step = a / 150;
  for (let x = -a; x <= a; x += step)
    for (let y = dy - r; y <= b + h; y += step) {
      const d2 = x * x + (y - dy) ** 2;
      const body =
        inConvex(hex, x, y) &&
        !inConvex(open, x, y) &&
        !(Math.abs(x) <= g / 2 && y >= b * k) &&
        d2 > (r + g) ** 2;
      if (body || d2 <= r * r) {
        sum += y;
        count++;
      }
    }
  return sum / count;
}

function place(kind, gap) {
  const layout = LAYOUT[kind];
  const a = (layout.height * layout.box) / (2 * T30 + 0.96 - DOT.y + DOT.r);
  const geo = geometry(a, gap);
  // Halfway between centring the visual weight and centring the bounding box: the heavy box
  // stays near the middle without pushing the dot against the top edge.
  const byWeight = 60 - visualCentre(geo);
  const byBounds = 60 - (geo.dy - geo.r + geo.b + geo.h) / 2;
  return { ...geo, ox: 60, oy: (byWeight + byBounds) / 2 };
}

function roundedPolygon(points, radius) {
  return (
    points
      .map((p, i) => {
        const prev = points[(i - 1 + points.length) % points.length];
        const next = points[(i + 1) % points.length];
        const towards = (q) => {
          const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
          return [p[0] + ((q[0] - p[0]) * radius) / len, p[1] + ((q[1] - p[1]) * radius) / len];
        };
        return `${i ? 'L' : 'M'}${pt(towards(prev))} Q${pt(p)} ${pt(towards(next))}`;
      })
      .join(' ') + ' Z'
  );
}

let uid = 0;

function markShapes(geo, paint) {
  const { a, b, h, k, g, r, dy, ox, oy } = geo;
  const P = ([x, y]) => [ox + x, oy + y];
  const hex = roundedPolygon([P([-a, 0]), P([0, -b]), P([a, 0]), P([a, h]), P([0, b + h]), P([-a, h])], a * 0.05);
  const opening = [P([-a * k, 0]), P([0, -b * k]), P([a * k, 0]), P([0, b * k])];
  const id = `sfm${++uid}`;
  // The opening, the front edge and a ring around the dot are cut out of the box.
  return (
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="120">` +
    `<rect width="120" height="120" fill="#fff"/>` +
    `<path d="M${opening.map(pt).join(' L')} Z" fill="#000"/>` +
    `<rect x="${num(ox - g / 2)}" y="${num(oy + b * k)}" width="${num(g)}" height="${num(b + h - b * k + 2)}" fill="#000"/>` +
    `<circle cx="${num(ox)}" cy="${num(oy + dy)}" r="${num(r + g)}" fill="#000"/></mask>` +
    `<path d="${hex}" fill="${paint.body}" mask="url(#${id})"/>` +
    `<circle cx="${num(ox)}" cy="${num(oy + dy)}" r="${num(r)}" fill="${paint.dot}"/>`
  );
}

// light = for light surfaces, dark = for dark surfaces. Lime lacks contrast on white,
// so light-surface versions stay single-colour ink.
export const VARIANTS = {
  'mark-light': { kind: 'mark', body: COLOR.ink, dot: COLOR.ink },
  'mark-dark': { kind: 'mark', body: COLOR.white, dot: COLOR.lime },
  'mark-white': { kind: 'mark', body: COLOR.white, dot: COLOR.white },
  'taskbar-light': { kind: 'taskbar', body: COLOR.ink, dot: COLOR.ink },
  'taskbar-dark': { kind: 'taskbar', body: COLOR.white, dot: COLOR.lime },
  'icon-dark': { kind: 'tile', tile: COLOR.ink, body: COLOR.white, dot: COLOR.lime },
  'icon-light': { kind: 'tile', tile: COLOR.tileLight, edge: COLOR.tileLightEdge, body: COLOR.ink, dot: COLOR.ink },
};

// px: target pixel size. Small renders widen the cut-outs to at least 0.9 px so the
// opening and the dot stay readable.
export function svg(name, { size, px } = {}) {
  const v = VARIANTS[name];
  const base = place(v.kind);
  const minGap = px ? (0.9 * 120) / px : 0;
  const geo = minGap > base.g ? place(v.kind, minGap) : base;
  const tile = v.tile
    ? `<rect x="${TILE.x}" y="${TILE.x}" width="${TILE.size}" height="${TILE.size}" rx="${TILE.radius}" fill="${v.tile}"` +
      (v.edge ? ` stroke="${v.edge}" stroke-width="0.9"` : '') +
      '/>'
    : '';
  const wh = size ? ` width="${size}" height="${size}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"${wh}>${tile}${markShapes(geo, v)}</svg>`;
}

// ------------------------------------------------------------------ rasterising

export async function browser() {
  // Resolves from the repository; falls back to the working directory when copied elsewhere.
  const { chromium } = await import('playwright').catch(() =>
    createRequire(path.join(process.cwd(), 'noop.js'))('playwright'),
  );
  const executablePath = process.env.SCIENTIFY_BROWSER_PATH;
  if (executablePath) return chromium.launch({ executablePath });
  try {
    return await chromium.launch({ channel: 'chrome' });
  } catch {
    return chromium.launch({ channel: 'msedge' });
  }
}

export async function rasterise(page, markup, size, background = 'transparent') {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:${background}">${markup.replace('<svg ', '<svg style="display:block" ')}</body></html>`,
  );
  return page.screenshot({ omitBackground: background === 'transparent', clip: { x: 0, y: 0, width: size, height: size } });
}

// PNG-compressed ICO. The 256 px frame goes first: Tauri uses entry 0 as the window icon.
function ico(frames) {
  const sorted = [...frames].sort((x, y) => y.size - x.size);
  const header = Buffer.alloc(6 + 16 * sorted.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sorted.length, 4);
  let offset = header.length;
  sorted.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header[at] = header[at + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...sorted.map((f) => f.png)]);
}

const PNG_SIGNATURE = '89504e470d0a1a0a';
const isRgbaPng = (buf, size) =>
  buf.subarray(0, 8).toString('hex') === PNG_SIGNATURE &&
  buf.readUInt32BE(16) === size &&
  buf.readUInt32BE(20) === size &&
  buf[25] === 6;

function icoFrames(buf) {
  return Array.from({ length: buf.readUInt16LE(4) }, (_, i) => {
    const at = 6 + 16 * i;
    const size = buf[at] || 256;
    const start = buf.readUInt32LE(at + 12);
    return { size, ok: isRgbaPng(buf.subarray(start, start + buf.readUInt32LE(at + 8)), size) };
  });
}

// ------------------------------------------------------------------ preview sheet

const UI = {
  light: { bg: '#fff', chrome: '#f7f7f7', text: '#242727', muted: '#626867', line: '#e5e7e6', selected: '#eaeaea' },
  dark: { bg: '#202222', chrome: '#1b1d1d', text: '#e5e9ec', muted: '#aab5bd', line: '#343837', selected: '#343a37' },
};

function topbar(theme) {
  const t = UI[theme];
  return `<div class="topbar" style="background:${t.bg};color:${t.text};border-bottom:1px solid ${t.line}">
    <span class="brand">${svg(`mark-${theme}`, { size: 24, px: 48 })}<b>Scientify</b></span><i style="background:${t.line}"></i>
    <span class="proj">线性回归方法对照 <small>▾</small></span><span class="dots" style="color:${t.muted}">◐ &nbsp;—&nbsp; ☐ &nbsp;✕</span></div>`;
}

function launcher(theme) {
  const t = UI[theme];
  return `<div class="launcher" style="background:${t.chrome};color:${t.text}">
    <div class="lbrand">${svg(`mark-${theme}`, { size: 32, px: 64 })}<b>Scientify</b></div>
    <div class="lnav" style="color:${t.muted}"><span style="background:${t.selected};color:${t.text}">个人空间</span><span>团队空间</span></div></div>`;
}

function taskbar(theme) {
  const ghost = `<span class="ghost" style="background:${theme === 'dark' ? '#3a3a3a' : '#cfd3d8'}"></span>`;
  return `<div class="taskbar" style="background:${theme === 'dark' ? '#1c1c1c' : '#eef0f2'}">${ghost}${ghost}
    <span class="tb-app">${svg('icon-dark', { size: 24, px: 24 })}<u></u></span>${ghost}${ghost}</div>`;
}

export function previewHtml() {
  const ladder = (name) =>
    [16, 20, 24, 32, 48, 64, 128]
      .map((s) => `<figure>${svg(name, { size: s, px: s })}<figcaption>${s}</figcaption></figure>`)
      .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Scientify Logo Kit</title><style>
*{box-sizing:border-box} body{margin:0;padding:40px 48px 56px;background:#E9E7E0;color:${COLOR.ink};font:14px/1.6 'Segoe UI Variable Text','Segoe UI','Microsoft YaHei UI',sans-serif}
h1{margin:0;font-size:26px} .lead{margin:6px 0 26px;color:#4d5552} h2{font-size:15px;margin:34px 0 12px;color:#4d5552}
.hero{display:grid;grid-template-columns:repeat(3,1fr);gap:16px} .hero>div{border-radius:16px;height:340px;display:flex;align-items:center;justify-content:center;position:relative}
.hero small{position:absolute;left:16px;bottom:12px;font-size:12px;color:#7c8481} .guide svg{outline:1px dashed rgba(17,26,23,.25)}
.ladders{background:#fff;border-radius:16px;padding:18px 22px;display:grid;gap:10px}
.ladder{display:flex;align-items:flex-end;gap:22px;padding:10px 14px;border-radius:10px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px} figcaption{font-size:11px;color:#8a918e}
.ctx{display:grid;grid-template-columns:1fr 1fr;gap:16px} .ctx>div{background:#F7F6F2;border-radius:16px;padding:16px;display:grid;gap:10px;align-content:start}
.ctx h3{margin:0;font-size:13px;color:#6b7370;font-weight:600}
.topbar{height:44px;display:flex;align-items:center;gap:12px;padding:0 12px;border-radius:8px}
.topbar .brand{display:flex;align-items:center;gap:7px;font-size:14px} .topbar .brand b{font-weight:650}
.topbar i{width:1px;height:18px} .topbar .proj{font-size:13px} .topbar .dots{margin-left:auto;font-size:12px;letter-spacing:2px}
.launcher{border-radius:8px;width:260px;padding-bottom:14px} .lbrand{height:94px;padding:0 27px;display:flex;align-items:center;gap:12px;font-size:24px}
.lbrand b{font-weight:650} .lnav{display:grid;gap:4px;padding:0 16px;font-size:13px} .lnav span{padding:6px 10px;border-radius:4px}
.taskbar{height:48px;border-radius:8px;display:flex;align-items:center;justify-content:center;gap:10px}
.taskbar .ghost{width:24px;height:24px;border-radius:6px;margin:0 8px} .tb-app{position:relative;display:flex;padding:8px;border-radius:6px;background:rgba(255,255,255,.08)}
.tb-app u{position:absolute;left:50%;bottom:1px;width:16px;height:3px;margin-left:-8px;border-radius:2px;background:#5fb2f2}
.tabbar{background:#dfe3e1;border-radius:8px;padding:8px 8px 0;height:44px} .tab{background:#fff;border-radius:8px 8px 0 0;height:36px;width:220px;display:flex;align-items:center;gap:8px;padding:0 12px;font-size:12px}
.tab small{margin-left:auto;color:#999}
.readme{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:18px;text-align:center}
.readme h4{margin:6px 0 2px;font-size:26px} .readme p{margin:0;font-size:14px}
.notes{background:#F7F6F2;border-radius:16px;padding:16px 22px;color:#3b4240} .notes li{margin:4px 0} code{font:12px Consolas,monospace;background:#fff;padding:1px 5px;border-radius:4px}
.sw{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-1px;margin-right:4px;border:1px solid rgba(0,0,0,.15)}
</style></head><body>
<h1>Scientify Logo Kit · 开箱</h1>
<p class="lead">一只打开的箱子，一颗从箱口升起的圆点。箱子是安放文献、代码和运行环境的科研沙箱，圆点是从中诞生的结果。</p>
<div class="hero">
  <div style="background:#DCDAD2"><div class="guide">${svg('icon-dark', { size: 280 })}</div><small>App 图标 · 默认（深色底）</small></div>
  <div style="background:#fff"><div class="guide">${svg('mark-light', { size: 280 })}</div><small>标志 · 浅色背景（虚线为画布边界）</small></div>
  <div style="background:${COLOR.ink}"><div class="guide">${svg('mark-dark', { size: 280 })}</div><small style="color:#8a948f">标志 · 深色背景</small></div>
</div>
<h2>实际像素</h2>
<div class="ladders">
  <div class="ladder">${ladder('icon-dark')}</div>
  <div class="ladder">${ladder('icon-light')}</div>
  <div class="ladder">${ladder('mark-light')}</div>
  <div class="ladder" style="background:${COLOR.ink}">${ladder('mark-dark')}</div>
</div>
<h2>放进产品里</h2>
<div class="ctx">
  <div><h3>工作区顶栏 · 24 px（浅色 / 深色主题）</h3>${topbar('light')}${topbar('dark')}</div>
  <div><h3>Windows 任务栏 · 24 px（深色 / 浅色）</h3>${taskbar('dark')}${taskbar('light')}
    <h3>浏览器标签 · 16 px</h3><div class="tabbar"><div class="tab">${svg('icon-dark', { size: 16, px: 16 })}<span>Scientify</span><small>✕</small></div></div></div>
  <div><h3>Projects 启动页侧栏 · 32 px</h3><div style="display:flex;gap:12px">${launcher('light')}${launcher('dark')}</div></div>
  <div><h3>GitHub README 头图</h3><div class="readme">${svg('icon-dark', { size: 88, px: 176 })}<h4>Scientify</h4><p><b>一个入口，贯穿科研全过程。</b></p></div></div>
</div>
<h2>规格</h2>
<div class="notes"><ul>
<li>颜色：<span class="sw" style="background:${COLOR.ink}"></span>墨黑 <code>${COLOR.ink}</code> · <span class="sw" style="background:${COLOR.lime}"></span>荧光绿 <code>${COLOR.lime}</code> · <span class="sw" style="background:#fff"></span>白 <code>#FFFFFF</code> · 浅色底板 <code>${COLOR.tileLight}</code></li>
<li>荧光绿只用在深色背景上；浅色背景用纯墨黑单色版。</li>
<li>App 图标默认用深色底板：白色箱体 + 荧光绿圆点。应用内顶栏按主题切换浅、深两版透明标志。</li>
<li>不要拉伸、旋转、加阴影或描边，不要单独改动圆点的大小和位置。</li>
</ul></div>
</body></html>`;
}

// ------------------------------------------------------------------ kit

const APP_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256, 512, 1024];
const TASKBAR_SIZES = [16, 20, 24, 32, 40, 48, 64];
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function write(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

export async function preview(dir, b) {
  write(path.join(dir, 'preview.html'), previewHtml());
  const page = await b.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(path.resolve(dir, 'preview.html')).href);
  await page.screenshot({ path: path.resolve(dir, 'preview.png'), fullPage: true });
  await page.close();
}

export async function kit(dir) {
  const assets = [];
  const icos = [];
  const put = (rel, data, meta) => {
    write(path.join(dir, rel), data);
    if (meta) assets.push({ file: rel, ...meta });
  };
  for (const name of ['mark-light', 'mark-dark', 'mark-white', 'icon-dark', 'icon-light'])
    put(`svg/scientify-${name}.svg`, svg(name) + '\n');
  put('web/favicon.svg', svg('icon-dark', { px: 32 }) + '\n');

  const b = await browser();
  const page = await b.newPage();
  // One page renders one image at a time; ICO frames reuse the PNGs written to the kit.
  const rendered = new Map();
  const png = async (name, size) => {
    const key = `${name}@${size}`;
    if (!rendered.has(key)) rendered.set(key, await rasterise(page, svg(name, { size, px: size }), size));
    return rendered.get(key);
  };
  const frames = async (name, sizes) => {
    const out = [];
    for (const size of sizes) out.push({ size, png: await png(name, size) });
    return out;
  };

  for (const theme of ['light', 'dark']) {
    for (const size of APP_SIZES) {
      put(`app/${theme}/scientify-${size}.png`, await png(`mark-${theme}`, size), { kind: 'app', theme, width: size, height: size });
      put(`desktop/${theme}/scientify-${size}.png`, await png(`icon-${theme}`, size), { kind: 'desktop', theme, width: size, height: size });
    }
    for (const size of TASKBAR_SIZES)
      put(`taskbar/${theme}/scientify-${size}.png`, await png(`taskbar-${theme}`, size), { kind: 'taskbar', theme, width: size, height: size });
    put(`master/scientify-${theme}-1024.png`, await png(`mark-${theme}`, 1024), { kind: 'master', theme, width: 1024, height: 1024 });
  }
  for (const size of [180, 192, 512])
    put(`web/icon-${size}.png`, await png('icon-dark', size), { kind: 'web', theme: 'dark', width: size, height: size });

  const icon = (rel, data) => {
    put(rel, data);
    icos.push(rel);
  };
  const desktopDark = ico(await frames('icon-dark', ICO_SIZES));
  icon('desktop/scientify.ico', desktopDark);
  icon('desktop/scientify-dark.ico', desktopDark);
  icon('desktop/scientify-light.ico', ico(await frames('icon-light', ICO_SIZES)));
  icon('taskbar/scientify-light.ico', ico(await frames('taskbar-light', ICO_SIZES)));
  icon('taskbar/scientify-dark.ico', ico(await frames('taskbar-dark', ICO_SIZES)));
  icon('web/favicon.ico', ico(await frames('icon-dark', [16, 32, 48])));

  // The mark is symmetric left to right. Measured without the tile, an empty or off-centre
  // mark means a bad render, such as a crop of another size.
  const centred = async (buf, tile) => {
    const box = await page.evaluate(
      async ([src, tile]) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const canvas = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, img.width, img.height);
        const t = tile && [1, 3, 5].map((i) => parseInt(tile.slice(i, i + 2), 16));
        let left = img.width;
        let right = -1;
        for (let i = 0; i < data.length; i += 4) {
          const far = !t || (data[i] - t[0]) ** 2 + (data[i + 1] - t[1]) ** 2 + (data[i + 2] - t[2]) ** 2 > 3600;
          if (data[i + 3] > 32 && far) {
            const x = (i / 4) % img.width;
            left = Math.min(left, x);
            right = Math.max(right, x);
          }
        }
        return { left, right, width: img.width };
      },
      [`data:image/png;base64,${buf.toString('base64')}`, tile],
    );
    return box.right >= 0 && Math.abs(box.left - (box.width - 1 - box.right)) <= Math.max(1, box.width / 48);
  };
  const tileOf = (file) =>
    /^(desktop\/(dark|scientify\.ico|scientify-dark)|web\/)/.test(file)
      ? COLOR.ink
      : /^desktop\/(light|scientify-light)/.test(file)
        ? COLOR.tileLight
        : null;
  const offCentre = [];
  for (const a of assets)
    if (!(await centred(readFileSync(path.join(dir, a.file)), tileOf(a.file)))) offCentre.push(a.file);
  for (const rel of icos) {
    const buf = readFileSync(path.join(dir, rel));
    for (let i = 0; i < buf.readUInt16LE(4); i++) {
      const at = 6 + 16 * i;
      const start = buf.readUInt32LE(at + 12);
      const frame = buf.subarray(start, start + buf.readUInt32LE(at + 8));
      if (!(await centred(frame, tileOf(rel)))) offCentre.push(`${rel}#${buf[at] || 256}`);
    }
  }
  await page.close();

  put(
    'web/site.webmanifest',
    JSON.stringify(
      {
        name: 'Scientify',
        short_name: 'Scientify',
        display: 'standalone',
        background_color: COLOR.ink,
        theme_color: COLOR.ink,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  put(
    'manifest.json',
    JSON.stringify(
      {
        brand: 'Scientify',
        source: 'source/build.mjs',
        master: 'svg/scientify-mark-light.svg',
        themeMeaning: { light: 'Ink mark for light surfaces', dark: 'White mark with lime dot for dark surfaces' },
        assets,
      },
      null,
      2,
    ) + '\n',
  );

  // Read everything back from disk before declaring the kit valid.
  const pngOk = assets.every((a) => isRgbaPng(readFileSync(path.join(dir, a.file)), a.width));
  const icoChecks = icos.map((rel) => ({ file: rel, frames: icoFrames(readFileSync(path.join(dir, rel))) }));
  const icoOk = icoChecks.every(({ frames }) => frames.every((f) => f.ok) && frames[0].size === frames.reduce((m, f) => Math.max(m, f.size), 0));
  put(
    'validation.json',
    JSON.stringify(
      {
        pngFilesChecked: assets.length,
        icoFilesChecked: icoChecks.length,
        icoFrameSizes: Object.fromEntries(icoChecks.map(({ file, frames }) => [file, frames.map((f) => f.size)])),
        rgba: pngOk,
        largestIcoFrameFirst: icoOk,
        offCentre,
        status: pngOk && icoOk && !offCentre.length ? 'passed' : 'failed',
      },
      null,
      2,
    ) + '\n',
  );
  await preview(dir, b);
  await b.close();
  if (!pngOk || !icoOk || offCentre.length) throw new Error('Kit validation failed; see validation.json.');
  return assets.length + icoChecks.length;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode = 'kit', out = fileURLToPath(new URL('..', import.meta.url))] = process.argv.slice(2);
  if (mode === 'kit') console.log(`Kit ready: ${await kit(out)} PNG/ICO files in ${out}`);
  else if (mode === 'preview') {
    const b = await browser();
    await preview(out, b);
    await b.close();
  } else throw new Error(`Unknown mode: ${mode}`);
}
