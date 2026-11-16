// Shared pieces of the admin pages: icons, formatting, cards, charts,
// tooltips, dialogs and toasts. Pages build HTML strings with these.

const P = {
  dash: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  team: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/>',
  plan: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8M12 17.5v-11"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  box: '<path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
};
export const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] ?? ''}</svg>`;

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmt = (value) => Math.round(Number(value) || 0).toLocaleString('en-US');
export const money = (value) => `¥${(Number(value) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
export const short = (value) => {
  const v = Number(value) || 0;
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)} 亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(v % 1e4 ? 1 : 0)} 万`;
  return fmt(v);
};
export function bytes(value) {
  const v = Number(value) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(v >= 10 * 1024 ** 3 ? 1 : 2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
}
const pad = (n) => String(n).padStart(2, '0');
export const date = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const time = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  return `${date(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export function ago(value) {
  if (!value) return '从未';
  const seconds = (Date.now() - new Date(value).getTime()) / 1000;
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} 天前`;
  return date(value);
}
export const md = (day) => String(day).slice(5);

export const chip = (text, cls = '') => `<span class="chip ${cls}">${text}</span>`;
export const planChip = (planId, name) => chip(esc(name ?? planId), planId === 'free' ? '' : 'pro');
export const statusChip = (status) =>
  status === 'active' ? chip(`${icon('ok')}正常`, 'ok') : chip(`${icon('alert')}已停用`, 'bad');
export const ROLE = { owner: '所有者', editor: '编辑', reviewer: '审阅', viewer: '查看' };
export const roleTag = (role) => `<span class="role ${esc(role)}">${ROLE[role] ?? esc(role)}</span>`;

export function meter(used, total, label) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  const level = pct >= 100 ? 'full' : pct >= 85 ? 'hi' : '';
  return `<div class="meter"><div class="bar"><i class="${level}" style="width:${pct}%"></i></div><span>${label}</span></div>`;
}
export const card = (title, body, { sub = '', actions = '', flush = false } = {}) =>
  `<section class="card"><div class="card-head"><h2>${title}</h2>${sub ? `<span class="sub">${sub}</span>` : ''}<span class="spacer"></span>${actions}</div><div class="${flush ? 'card-body flush' : 'card-body'}">${body}</div></section>`;
export const tile = (k, v, d = '', attrs = '') =>
  attrs
    ? `<button class="tile" ${attrs}><div class="k">${k}</div><div class="v num">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</button>`
    : `<div class="tile"><div class="k">${k}</div><div class="v num">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;
export const empty = (text) => `<div class="empty">${text}</div>`;
export const seg = (key, value, options) =>
  `<div class="seg">${options.map(([v, label]) => `<button class="${String(value) === String(v) ? 'on' : ''}" data-act="set" data-key="${key}" data-value="${esc(v)}">${label}</button>`).join('')}</div>`;

// ---------- Tooltips and charts ----------
const TIPS = new Map();
const CHARTS = new Map();
let sequence = 0;
export function resetRegistry() {
  TIPS.clear();
  CHARTS.clear();
}
export function tip(html) {
  const id = `t${++sequence}`;
  TIPS.set(id, html);
  return id;
}
export const tipRow = (color, name, value) =>
  `<div class="r">${color ? `<i style="background:${color}"></i>` : ''}${esc(name)}<b>${value}</b></div>`;
export function chart(draw) {
  const id = `c${++sequence}`;
  CHARTS.set(id, draw);
  return `<div class="chart" data-chart="${id}"></div>`;
}
export function drawCharts() {
  document.querySelectorAll('[data-chart]').forEach((element) => {
    const draw = CHARTS.get(element.dataset.chart);
    if (draw) element.innerHTML = draw(Math.max(220, element.clientWidth));
  });
}
export const legend = (series, line = false) =>
  `<div class="legend">${series.map((s) => `<span><i class="${line ? 'line' : ''}" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;

/** Series colours follow a fixed order; a ninth series and beyond share "其他". */
export function seriesFor(models) {
  const list = models.slice(0, 7).map((model, index) => ({ key: model.id, name: model.name, color: `var(--s${index + 1})` }));
  if (models.length > 7) list.push({ key: '__other', name: '其他', color: 'var(--text-4)', keys: models.slice(7).map((m) => m.id) });
  return list;
}
export function rowsFor(series, daily) {
  return daily.map((day) => {
    const row = {};
    for (const s of series) row[s.key] = s.keys ? s.keys.reduce((sum, key) => sum + (day[key] ?? 0), 0) : (day[s.key] ?? 0);
    return row;
  });
}

function niceScale(max, count = 4) {
  const raw = Math.max(max, 1) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { top, ticks };
}
function axes(w, h, m, scale, fmtY) {
  let out = '';
  for (const t of scale.ticks) {
    const y = m.t + (h - m.t - m.b) * (1 - t / scale.top);
    out += `<line class="${t === 0 ? 'baseline' : 'gridline'}" x1="${m.l}" x2="${w - m.r}" y1="${y}" y2="${y}"/>`;
    out += `<text x="${m.l - 8}" y="${y + 4}" text-anchor="end">${fmtY(t)}</text>`;
  }
  return out;
}
const topRounded = (x, y, w, h, r) => {
  if (h <= 0) return '';
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};
const rightRounded = (x, y, w, h, r) => {
  if (w <= 0) return '';
  r = Math.min(r, w, h / 2);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
};
const labelEvery = (count) => (count <= 10 ? 1 : count <= 31 ? 5 : 10);

export function lineChart({ labels, series, height = 200, unit = '' }) {
  return (w) => {
    const m = { l: 46, r: 12, t: 10, b: 26 };
    const scale = niceScale(Math.max(...series.flatMap((s) => s.data), 1));
    const iw = w - m.l - m.r;
    const x = (i) => m.l + (labels.length > 1 ? (iw * i) / (labels.length - 1) : iw / 2);
    const y = (v) => m.t + (height - m.t - m.b) * (1 - v / scale.top);
    let svg = axes(w, height, m, scale, short);
    const every = labelEvery(labels.length);
    labels.forEach((label, i) => {
      if (i % every === every - 1 || i === 0) svg += `<text x="${x(i)}" y="${height - 8}" text-anchor="middle">${esc(label)}</text>`;
    });
    for (const s of series)
      svg += `<path d="${s.data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    svg += `<line class="cross" x1="0" x2="0" y1="${m.t}" y2="${height - m.b}" style="display:none"/>`;
    const band = labels.length > 1 ? iw / (labels.length - 1) : iw;
    labels.forEach((label, i) => {
      const id = tip(`<div class="h">${esc(label)}</div>${series.map((s) => tipRow(s.color, s.name, fmt(s.data[i]) + unit)).join('')}`);
      svg += `<rect class="hit" data-tip="${id}" data-cx="${x(i)}" x="${x(i) - band / 2}" y="${m.t}" width="${band}" height="${height - m.t - m.b}"/>`;
    });
    return `<svg viewBox="0 0 ${w} ${height}" height="${height}">${svg}</svg>`;
  };
}

export function stackChart({ labels, rows, series, height = 220, unit = ' 点' }) {
  return (w) => {
    const m = { l: 46, r: 8, t: 10, b: 26 };
    const totals = rows.map((r) => series.reduce((sum, s) => sum + (r[s.key] ?? 0), 0));
    const scale = niceScale(Math.max(...totals, 1));
    const iw = w - m.l - m.r;
    const band = iw / Math.max(1, labels.length);
    const bw = Math.max(3, Math.min(22, band * 0.62));
    const ih = height - m.t - m.b;
    let svg = axes(w, height, m, scale, short);
    const every = labelEvery(labels.length);
    rows.forEach((r, i) => {
      const cx = m.l + band * i + band / 2;
      let base = height - m.b;
      const visible = series.filter((s) => (r[s.key] ?? 0) > 0);
      visible.forEach((s, j) => {
        const h = (ih * r[s.key]) / scale.top;
        const gap = j ? 2 : 0;
        const y0 = base - h;
        if (j === visible.length - 1) svg += `<path d="${topRounded(cx - bw / 2, y0, bw, Math.max(0, h - gap), 4)}" fill="${s.color}"/>`;
        else svg += `<rect x="${cx - bw / 2}" y="${y0}" width="${bw}" height="${Math.max(0, h - gap)}" fill="${s.color}"/>`;
        base = y0;
      });
      if (i % every === every - 1 || i === 0) svg += `<text x="${cx}" y="${height - 8}" text-anchor="middle">${esc(labels[i])}</text>`;
      const id = tip(
        `<div class="h">${esc(labels[i])}</div>${series.map((s) => tipRow(s.color, s.name, fmt(r[s.key] ?? 0) + unit)).join('')}${series.length > 1 ? tipRow('', '合计', fmt(totals[i]) + unit) : ''}`,
      );
      svg += `<rect class="hit" data-tip="${id}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>`;
    });
    return `<svg viewBox="0 0 ${w} ${height}" height="${height}">${svg}</svg>`;
  };
}

export function groupedChart({ labels, series, height = 220, format = money }) {
  return (w) => {
    const m = { l: 56, r: 8, t: 10, b: 26 };
    const scale = niceScale(Math.max(...series.flatMap((s) => s.data), 1));
    const iw = w - m.l - m.r;
    const band = iw / labels.length;
    const bw = Math.max(3, Math.min(18, (band * 0.7) / series.length - 2));
    const ih = height - m.t - m.b;
    let svg = axes(w, height, m, scale, (v) => `¥${short(v)}`);
    labels.forEach((label, i) => {
      const start = m.l + band * i + (band - (bw + 2) * series.length + 2) / 2;
      series.forEach((s, j) => {
        const h = (ih * s.data[i]) / scale.top;
        svg += `<path d="${topRounded(start + j * (bw + 2), height - m.b - h, bw, h, 4)}" fill="${s.color}"/>`;
      });
      svg += `<text x="${m.l + band * i + band / 2}" y="${height - 8}" text-anchor="middle">${esc(label)}</text>`;
      const id = tip(`<div class="h">${esc(label)}</div>${series.map((s) => tipRow(s.color, s.name, format(s.data[i]))).join('')}`);
      svg += `<rect class="hit" data-tip="${id}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>`;
    });
    return `<svg viewBox="0 0 ${w} ${height}" height="${height}">${svg}</svg>`;
  };
}

export function hbarChart({ items, color = 'var(--s1)', unit = ' 点' }) {
  return (w) => {
    const row = 26;
    const m = { l: 92, r: 64 };
    const max = Math.max(...items.map((d) => d.value), 1);
    const height = Math.max(row, items.length * row);
    let svg = '';
    items.forEach((d, i) => {
      const y = i * row + 5;
      const bw = ((w - m.l - m.r) * d.value) / max;
      svg += `<text class="label" x="${m.l - 8}" y="${y + 12}" text-anchor="end">${esc(d.label)}</text>`;
      svg += `<path d="${rightRounded(m.l, y, Math.max(bw, 1), 16, 4)}" fill="${color}"/>`;
      svg += `<text class="label" x="${m.l + bw + 6}" y="${y + 12}">${fmt(d.value)}</text>`;
      const id = tip(`<div class="h">${esc(d.label)}</div>${tipRow(color, '用量', fmt(d.value) + unit)}`);
      svg += `<rect class="hit" data-tip="${id}" x="0" y="${y - 4}" width="${w}" height="${row}"/>`;
    });
    return `<svg viewBox="0 0 ${w} ${height}" height="${height}">${svg}</svg>`;
  };
}

export function stackBarH({ items, series }) {
  return (w) => {
    const row = 30;
    const m = { l: 130, r: 76 };
    const totals = items.map((d) => series.reduce((sum, s) => sum + (d[s.key] ?? 0), 0));
    const max = Math.max(...totals, 1);
    const height = Math.max(row, items.length * row);
    let svg = '';
    items.forEach((d, i) => {
      const y = i * row + 6;
      let x = m.l;
      svg += `<text class="label" x="${m.l - 8}" y="${y + 13}" text-anchor="end">${esc(d.label)}</text>`;
      const visible = series.filter((s) => (d[s.key] ?? 0) > 0);
      visible.forEach((s, j) => {
        const bw = ((w - m.l - m.r) * d[s.key]) / max;
        const last = j === visible.length - 1;
        const width = Math.max(0.5, bw - (last ? 0 : 2));
        svg += last ? `<path d="${rightRounded(x, y, width, 18, 4)}" fill="${s.color}"/>` : `<rect x="${x}" y="${y}" width="${width}" height="18" fill="${s.color}"/>`;
        x += bw;
      });
      svg += `<text class="label" x="${x + 6}" y="${y + 13}">${bytes(totals[i])}</text>`;
      const id = tip(`<div class="h">${esc(d.label)}</div>${series.map((s) => tipRow(s.color, s.name, bytes(d[s.key] ?? 0))).join('')}`);
      svg += `<rect class="hit" data-tip="${id}" x="0" y="${y - 6}" width="${w}" height="${row}"/>`;
    });
    return `<svg viewBox="0 0 ${w} ${height}" height="${height}">${svg}</svg>`;
  };
}

export function installTooltips() {
  const box = document.createElement('div');
  box.className = 'tip';
  box.style.display = 'none';
  document.body.append(box);
  document.addEventListener('mousemove', (event) => {
    const target = event.target.closest?.('[data-tip]');
    document.querySelectorAll('.cross').forEach((line) => (line.style.display = 'none'));
    const html = target && TIPS.get(target.dataset.tip);
    if (!html) {
      box.style.display = 'none';
      return;
    }
    box.innerHTML = html;
    box.style.display = 'block';
    const rect = box.getBoundingClientRect();
    let x = event.clientX + 14;
    let y = event.clientY + 14;
    if (x + rect.width > innerWidth - 8) x = event.clientX - rect.width - 14;
    if (y + rect.height > innerHeight - 8) y = event.clientY - rect.height - 14;
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    if (target.dataset.cx) {
      const cross = target.closest('svg')?.querySelector('.cross');
      if (cross) {
        cross.setAttribute('x1', target.dataset.cx);
        cross.setAttribute('x2', target.dataset.cx);
        cross.style.display = '';
      }
    }
  });
}

// ---------- Toast and dialogs ----------
let toastTimer = 0;
export function toast(text, error = false) {
  document.querySelector('.toast')?.remove();
  const element = document.createElement('div');
  element.className = 'toast';
  if (error) element.style.background = 'var(--bad)';
  element.innerHTML = `${icon(error ? 'alert' : 'ok')}${esc(text)}`;
  document.body.append(element);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.remove(), error ? 5000 : 2600);
}

export const frame = (title, bodyHtml, footer, wide = false) =>
  `<div class="scrim" data-act="scrim"><div class="dialog ${wide ? 'wide' : ''}" role="dialog" aria-label="${esc(title)}"><header><h3>${title}</h3><button class="icon-btn" data-act="close" aria-label="关闭">${icon('x')}</button></header><div class="body">${bodyHtml}<div class="form-error" data-error></div></div><footer>${footer}</footer></div></div>`;

/** Values of the named fields in the open dialog. */
export function fields() {
  const out = {};
  document.querySelectorAll('#layer [name]').forEach((element) => {
    out[element.name] = element.type === 'checkbox' ? element.checked : element.value;
  });
  return out;
}
export function dialogError(text) {
  const element = document.querySelector('#layer [data-error]');
  if (element) element.textContent = text;
}

/** Saves text as a file the browser downloads. */
export function download(name, text) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }));
  link.download = name;
  document.body.append(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 1000);
}
