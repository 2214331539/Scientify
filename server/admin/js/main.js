// The admin shell: sign-in, navigation, hash routes and event dispatch.

import { SignedOut, get, post } from './api.js';
import { dialogError, drawCharts, esc, icon, installTooltips, resetRegistry, toast } from './ui.js';
import { errorsPage, overview, teamPage, teamsPage, userPage, usersPage } from './pages-ops.js';
import { auditPage, codesPage, modelsPage, ordersPage, plansPage, usagePage } from './pages-billing.js';

const NAV = [
  { group: '运营' },
  { id: 'overview', name: '概览', icon: 'dash' },
  { id: 'users', name: '用户', icon: 'users' },
  { id: 'teams', name: '团队', icon: 'team' },
  { group: '计费' },
  { id: 'plans', name: '套餐与额度', icon: 'plan' },
  { id: 'codes', name: '兑换码', icon: 'ticket' },
  { id: 'models', name: '模型与渠道', icon: 'cpu' },
  { id: 'usage', name: '用量', icon: 'chart' },
  { id: 'orders', name: '订单', icon: 'receipt' },
  { group: '系统' },
  { id: 'errors', name: '错误', icon: 'alert' },
  { id: 'audit', name: '审计', icon: 'shield' },
];
const PAGES = { overview, users: usersPage, teams: teamsPage, plans: plansPage, codes: codesPage, models: modelsPage, usage: usagePage, orders: ordersPage, errors: errorsPage, audit: auditPage };

const state = { admin: null, plans: [], theme: localStorage.getItem('sf-admin-theme') || 'light' };
let current = { page: null, route: null, data: null };
let ticket = 0;

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'overview';
  const [path, search = ''] = raw.split('?');
  const [view, id] = path.split('/').map(decodeURIComponent);
  return { view: PAGES[view] ? view : 'overview', id: id || null, query: Object.fromEntries(new URLSearchParams(search)) };
}
function routeHash(route) {
  const query = new URLSearchParams(Object.entries(route.query).filter(([, v]) => v !== '' && v !== undefined && v !== null)).toString();
  return `#/${route.view}${route.id ? `/${encodeURIComponent(route.id)}` : ''}${query ? `?${query}` : ''}`;
}
function pageFor(route) {
  if (route.view === 'users' && route.id) return userPage;
  if (route.view === 'teams' && route.id) return teamPage;
  return PAGES[route.view];
}

const ctx = {
  get route() {
    return current.route;
  },
  get data() {
    return current.data;
  },
  state,
  dialog(html) {
    document.getElementById('layer').innerHTML = html;
    document.querySelector('#layer input:not([type=hidden]):not([readonly]), #layer select')?.focus();
  },
  close() {
    document.getElementById('layer').innerHTML = '';
  },
  async reload(keepScroll = true) {
    await show(keepScroll);
  },
};

function shell(title, body) {
  return `<div class="shell">
    <aside class="side">
      <div class="brand"><span class="logo">${icon('box')}</span><span>Scientify<small>管理后台</small></span></div>
      ${NAV.map((n) => (n.group ? `<div class="nav-group">${n.group}</div>` : `<button class="nav-item ${current.route?.view === n.id ? 'on' : ''}" data-go="#/${n.id}">${icon(n.icon)}${n.name}</button>`)).join('')}
      <div class="side-foot"><div class="avatar sm">${icon('users')}</div><div class="me"><b class="num">${esc(state.admin?.phone ?? '')}</b><span>${esc(state.admin?.roleName ?? '')}</span></div><button class="icon-btn" data-act="theme" title="切换深色">${icon('moon')}</button><button class="icon-btn" data-act="sign-out" title="退出">${icon('logout')}</button></div>
    </aside>
    <main class="main">
      <div class="top">${title}<span class="spacer"></span><button class="btn ghost" data-act="refresh" title="刷新">${icon('refresh')}刷新</button></div>
      <div class="content">${body}</div>
    </main>
  </div>`;
}

async function show(keepScroll = false) {
  const route = parseRoute();
  const page = pageFor(route);
  const mine = ++ticket;
  const root = document.getElementById('root');
  const scroll = keepScroll ? (root.querySelector('.content')?.scrollTop ?? 0) : 0;
  const sameView = current.route && current.route.view === route.view && current.route.id === route.id;
  if (!sameView) {
    current = { page, route, data: null };
    resetRegistry();
    root.innerHTML = shell(`<h1>${esc(NAV.find((n) => n.id === route.view)?.name ?? '')}</h1>`, '<div class="loading">正在加载…</div>');
  }
  let data;
  try {
    data = await page.load(route);
  } catch (error) {
    if (error instanceof SignedOut) return signInPage();
    if (mine !== ticket) return;
    current = { page, route, data: null };
    root.innerHTML = shell(`<h1>${esc(NAV.find((n) => n.id === route.view)?.name ?? '')}</h1>`, `<div class="note warn">${icon('alert')}<span>${esc(error.message)}</span></div>`);
    return;
  }
  if (mine !== ticket) return;
  current = { page, route, data };
  resetRegistry();
  const body = page.view(data, route, state);
  root.innerHTML = shell(typeof page.title === 'function' ? (page.title(data).startsWith('<') ? page.title(data) : `<h1>${esc(page.title(data))}</h1>`) : '', body);
  if (keepScroll) root.querySelector('.content').scrollTop = scroll;
  drawCharts();
  page.afterRender?.(ctx);
}

// ---------- Sign-in ----------
/** Password sign-in; "忘记密码" sets a new one after an SMS code. */
function signInPage(message = '', mode = 'password', phone = '') {
  state.admin = null;
  ctx.close();
  const reset = mode === 'reset';
  document.getElementById('root').innerHTML = `<div class="login"><form class="box" data-login="${mode}">
    <div class="brand" style="padding:0"><span class="logo">${icon('box')}</span><span>Scientify<small>管理后台</small></span></div>
    <h2>${reset ? '重设密码' : '登录'}</h2><div class="muted">${reset ? '验证码只发给管理员的手机号。这是账号的密码，重设后桌面应用需要重新登录。' : '只有管理员可以登录。'}</div>
    <div class="form-row"><label>手机号</label><input class="text num" name="phone" autocomplete="username" value="${esc(phone)}" required></div>
    ${
      reset
        ? `<div class="form-row"><label>短信验证码</label><div class="code-row"><input class="text num" name="code" inputmode="numeric" autocomplete="one-time-code" required><button class="btn" type="button" data-act="send-code">获取验证码</button></div></div>
           <div class="form-row"><label>新密码</label><input class="text" type="password" name="password" autocomplete="new-password" placeholder="8–64 位，包含字母和数字" required></div>
           <div class="form-row"><label>确认新密码</label><input class="text" type="password" name="confirm" autocomplete="new-password" required></div>`
        : `<div class="form-row"><label>密码</label><input class="text" type="password" name="password" autocomplete="current-password" required></div>`
    }
    <div class="form-error" data-login-error>${esc(message)}</div>
    <button class="btn primary" type="submit">${reset ? '重设并登录' : '登录'}</button>
    <div style="margin-top:12px;text-align:center"><button class="link" type="button" data-act="${reset ? 'to-sign-in' : 'to-reset'}">${reset ? '返回登录' : '忘记密码？'}</button></div>
    <div class="muted" style="margin:14px 0 0;font-size:12px">会话 8 小时后失效。管理员由服务器上的命令设置。</div>
  </form></div>`;
}

async function start() {
  document.documentElement.dataset.theme = state.theme;
  installTooltips();
  try {
    state.admin = await get('/me');
    state.plans = (await get('/plans')).plans;
  } catch (error) {
    return signInPage(error instanceof SignedOut ? '' : error.message);
  }
  await show();
}

// ---------- Events ----------
addEventListener('hashchange', () => state.admin && show());

document.addEventListener('submit', async (event) => {
  if (!event.target.matches('[data-login]')) return;
  event.preventDefault();
  const form = new FormData(event.target);
  const error = document.querySelector('[data-login-error]');
  const reset = event.target.dataset.login === 'reset';
  try {
    if (reset && form.get('password') !== form.get('confirm')) throw new Error('两次输入的密码不一致。');
    state.admin = reset
      ? (await post('/reset-password', { phone: form.get('phone'), code: form.get('code'), password: form.get('password') })).admin
      : (await post('/login', { phone: form.get('phone'), password: form.get('password') })).admin;
    state.plans = (await get('/plans')).plans;
    await show();
  } catch (reason) {
    error.textContent = reason.message;
  }
});

document.addEventListener('click', async (event) => {
  const go = event.target.closest('[data-go]');
  if (go && !event.target.closest('[data-act]')) {
    location.hash = go.dataset.go;
    return;
  }
  const element = event.target.closest('[data-act]');
  if (!element) return;
  const act = element.dataset.act;
  if (act === 'scrim' && event.target !== element) return;
  try {
    if (act === 'close' || act === 'scrim') return ctx.close();
    if (act === 'theme') {
      state.theme = state.theme === 'light' ? 'night' : 'light';
      localStorage.setItem('sf-admin-theme', state.theme);
      document.documentElement.dataset.theme = state.theme;
      return drawCharts();
    }
    if (act === 'refresh') return show(true);
    if (act === 'sign-out') {
      await post('/logout');
      return signInPage();
    }
    if (act === 'to-reset' || act === 'to-sign-in') {
      const phone = document.querySelector('[data-login] [name=phone]')?.value.trim() ?? '';
      return signInPage('', act === 'to-reset' ? 'reset' : 'password', phone);
    }
    if (act === 'send-code') {
      const phone = document.querySelector('[data-login] [name=phone]').value.trim();
      await post('/send-code', { phone });
      element.disabled = true;
      let left = 60;
      const timer = setInterval(() => {
        left -= 1;
        element.textContent = left > 0 ? `${left} 秒` : '重新获取';
        if (left <= 0) {
          clearInterval(timer);
          element.disabled = false;
        }
      }, 1000);
      return;
    }
    if (act === 'set') {
      const route = { ...current.route, query: { ...current.route.query, [element.dataset.key]: element.dataset.value } };
      if (element.dataset.key !== 'page' && route.query.page) delete route.query.page;
      location.hash = routeHash(route);
      return;
    }
    const handler = current.page?.act?.[act];
    if (!handler) return;
    if (element.tagName === 'BUTTON') element.disabled = true;
    try {
      await handler(element, ctx);
    } finally {
      if (element.isConnected && element.tagName === 'BUTTON') element.disabled = false;
    }
  } catch (error) {
    if (error instanceof SignedOut) return signInPage('登录已过期，请重新登录。');
    if (document.querySelector('#layer [data-error]')) dialogError(error.message);
    else toast(error.message, true);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') ctx.close();
  if (event.key === 'Enter' && event.target.matches('[data-search]')) {
    const route = { ...current.route, query: { ...current.route.query, q: event.target.value.trim() } };
    delete route.query.page;
    location.hash = routeHash(route);
  }
});
document.addEventListener('input', (event) => {
  if (event.target.closest('#layer') && event.target.matches('[data-live]')) current.page?.live?.(event.target, event.type, ctx);
});
document.addEventListener('change', (event) => {
  if (event.target.closest('#layer') && event.target.matches('[data-live]')) current.page?.live?.(event.target, event.type, ctx);
});
document.addEventListener('mouseover', (event) => {
  const hovered = event.target.closest?.('[data-hover-team]')?.dataset.hoverTeam ?? null;
  document.querySelectorAll('[data-hover-team]').forEach((element) => element.classList.toggle('hl', element.dataset.hoverTeam === hovered));
});
let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawCharts, 120);
});

start();
