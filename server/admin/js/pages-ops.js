// Operations pages: overview, users and teams.

import { get, post, del } from './api.js';
import {
  ROLE, ago, bytes, card, chart, chip, date, empty, esc, fields, fmt, frame, groupedChart, hbarChart, icon,
  legend, lineChart, md, meter, money, planChip, roleTag, rowsFor, seg, seriesFor, short, stackBarH, stackChart,
  statusChip, tile, time, tip, tipRow, toast,
} from './ui.js';

const level = { bad: 'alert', warn: 'alert', info: 'info' };
const alertTarget = (action) =>
  action.view === 'user'
    ? `#/users/${encodeURIComponent(action.id)}`
    : action.view === 'channels'
      ? '#/models?tab=channels'
      : action.view === 'model'
        ? `#/models?edit=${encodeURIComponent(action.id)}`
        : `#/${action.view}`;

// ---------- Overview ----------
export const overview = {
  title: () => '概览',
  async load() {
    const [data, catalog] = await Promise.all([get('/overview'), get('/models')]);
    return { ...data, models: catalog.models };
  },
  view(data) {
    const t = data.tiles;
    const series = seriesFor(data.models);
    const change = t.activeBefore ? Math.round(((t.active7 - t.activeBefore) / t.activeBefore) * 100) : null;
    const margin = t.pointsSold ? Math.round((1 - t.modelCost / (t.pointsSold / 100)) * 100) : null;
    const money3 = [
      { name: '收入', color: 'var(--s1)', data: data.revenueMonthly },
      { name: '模型成本', color: 'var(--s2)', data: data.costMonthly },
      { name: '存储（估算）', color: 'var(--s3)', data: data.storageMonthly },
    ];
    return `
      <div class="tiles">
        ${tile('注册用户', fmt(t.users), `本月 +${fmt(t.usersThisMonth)}`, 'data-go="#/users"')}
        ${tile('7 日活跃', fmt(t.active7), change === null ? '上周没有数据' : `<span class="${change >= 0 ? 'up' : 'down'}">较上周 ${change >= 0 ? '+' : ''}${change}%</span>`)}
        ${tile('付费用户', fmt(t.paidUsers), Object.entries(t.paidByPlan).map(([id, count]) => `${id === 'pro' ? '专业版' : id} ${count}`).join(' · ') || '还没有', 'data-go="#/users?plan=pro"')}
        ${tile('本月收入', money(t.revenue), `${t.paidOrders} 笔付款`, 'data-go="#/orders"')}
        ${tile('本月模型成本', money(t.modelCost), `售出 ${short(t.pointsSold)} 点${margin === null ? '' : ` · 毛利 ${margin}%`}`, 'data-go="#/usage"')}
        ${tile('同步空间', bytes(t.storageBytes), `按 ¥0.12/GB·月估算约 ${money(t.storageYuan)}`)}
      </div>
      <div class="grid g-main">
        <div class="grid" style="align-content:start">
          ${card('每日活跃和新注册', `<div class="mini-h">活跃用户</div>${chart(lineChart({ labels: data.days.map(md), series: [{ name: '活跃用户', color: 'var(--s1)', data: data.activeDaily }], height: 170, unit: ' 人' }))}<div class="mini-h" style="margin-top:14px">新注册</div>${chart(stackChart({ labels: data.days.map(md), rows: data.signupsDaily.map((n) => ({ n })), series: [{ key: 'n', name: '新注册', color: 'var(--s1)' }], height: 110, unit: ' 人' }))}`, { sub: '近 30 天' })}
          ${card('每日模型消耗', series.length ? legend(series) + chart(stackChart({ labels: data.days.map(md), rows: rowsFor(series, data.modelDaily), series })) : empty('还没有官方模型。'), { sub: '点 · 近 30 天', actions: `<button class="btn sm ghost" data-go="#/usage">用量明细${icon('right')}</button>` })}
        </div>
        <div class="grid" style="align-content:start">
          ${card('需要处理', data.alerts.length ? `<div class="alerts">${data.alerts.map((a) => `<div class="alert ${a.level}">${icon(level[a.level])}<div><div class="t">${esc(a.title)}</div><div class="s">${esc(a.detail)}</div></div>${a.action ? `<button class="btn sm" data-go="${alertTarget(a.action)}">${esc(a.action.label)}</button>` : ''}</div>`).join('')}</div>` : empty('没有需要处理的事。'), { sub: `${data.alerts.length} 项` })}
          ${card('收入和成本', legend(money3) + chart(groupedChart({ labels: data.months.map((m) => `${Number(m.slice(5))} 月`), series: money3 })), { sub: '按月' })}
        </div>
      </div>`;
  },
};

// ---------- Users ----------
const PAGE = 50;
export const usersPage = {
  title: () => '用户',
  async load(route) {
    const q = route.query;
    const params = new URLSearchParams({ q: q.q ?? '', plan: q.plan ?? 'all', status: q.status ?? 'all', limit: PAGE, offset: (Number(q.page) || 0) * PAGE });
    return get(`/users?${params}`);
  },
  view(data, route) {
    const q = route.query;
    const page = Number(q.page) || 0;
    const rows = data.users
      .map(
        (u) => `<tr class="click" data-go="#/users/${encodeURIComponent(u.id)}">
          <td class="who"><b>${esc(u.name)}</b><span class="muted num">${esc(u.phone)}</span>${u.adminRole ? ` ${chip('管理员')}` : ''}</td>
          <td>${planChip(u.plan.id, u.plan.name)}${u.plan.endsAt ? `<span class="muted num"> 至 ${date(u.plan.endsAt).slice(5)}</span>` : ''}</td>
          <td class="n">${fmt(u.balance)}</td>
          <td>${meter(u.monthPoints, Math.max(u.monthlyPoints, 1), `本月 ${fmt(u.monthPoints)} / ${fmt(u.monthlyPoints)}`)}</td>
          <td>${meter(u.storage.usedBytes, u.storage.limitBytes, bytes(u.storage.usedBytes))}</td>
          <td class="n">${u.projects}<span class="muted">（团队 ${u.teamProjects}）</span></td>
          <td class="muted">${ago(u.lastActiveAt)}</td>
          <td class="muted num">${date(u.createdAt)}</td>
          <td>${statusChip(u.status)}</td></tr>`,
      )
      .join('');
    return `
      <div class="toolbar">
        <label class="field" style="width:260px">${icon('search')}<input data-search placeholder="手机号、昵称或 ID，回车搜索" value="${esc(q.q ?? '')}"></label>
        ${seg('plan', q.plan ?? 'all', [['all', '全部套餐'], ['free', '免费'], ['pro', '专业版']])}
        ${seg('status', q.status ?? 'all', [['all', '全部状态'], ['active', '正常'], ['disabled', '已停用']])}
        <span class="grow"></span><span class="muted">共 ${fmt(data.total)} 人</span>
      </div>
      ${card('用户列表', data.users.length ? `<div class="table-wrap"><table><thead><tr><th>用户</th><th>套餐</th><th class="n">可用点数</th><th>本月官方模型用量</th><th>同步空间</th><th class="n">项目</th><th>最近活跃</th><th>注册</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table></div>
        <div class="pager"><span>第 ${page + 1} 页</span><button class="btn sm" data-act="set" data-key="page" data-value="${page - 1}" ${page ? '' : 'disabled'}>上一页</button><button class="btn sm" data-act="set" data-key="page" data-value="${page + 1}" ${(page + 1) * PAGE < data.total ? '' : 'disabled'}>下一页</button></div>` : empty('没有符合条件的用户。'), { flush: true })}`;
  },
};

const REASON = { usage: '使用', debt: '欠额', grant: '发放', adjust: '人工扣减', expire: '作废', settle: '抵扣欠额' };
const SOURCE = { manual: '手动开通', redeem: '兑换码', wechat: '微信支付', alipay: '支付宝' };

export const userPage = {
  title: (data) => `<div class="crumb"><button data-go="#/users">用户</button>${icon('right')}<h1>${esc(data?.user.name ?? '')}</h1></div>`,
  load: (route) => get(`/users/${encodeURIComponent(route.id)}`),
  view(data, route) {
    const { user, account } = data;
    const tab = route.query.tab ?? 'overview';
    const tabs = [['overview', '概况'], ['credits', '额度'], ['usage', '用量'], ['projects', '项目'], ['devices', '设备'], ['log', '操作记录']];
    const series = seriesFor(data.usage.models.map((m) => ({ id: m.id, name: m.name })));
    const dailyChart = (height) =>
      series.length
        ? legend(series) + chart(stackChart({ labels: data.usage.days.map((d) => md(d.day)), rows: rowsFor(series, data.usage.days.map((d) => d.models)), series, height }))
        : empty('近 30 天没有使用官方模型。');
    let body = '';
    if (tab === 'overview') {
      const sub = account.subscription;
      body = `<div class="grid g3">
        ${card('套餐', `<dl class="kv"><dt>当前</dt><dd>${planChip(account.plan.id, account.plan.name)}</dd><dt>本周期</dt><dd class="num">${date(account.period.start)} 至 ${date(account.period.end)}</dd><dt>到期</dt><dd class="num">${sub ? date(sub.endsAt) : '—'}</dd><dt>来源</dt><dd>${sub ? (SOURCE[sub.source] ?? esc(sub.source)) : '—'}</dd></dl>`, { actions: '<button class="btn sm" data-act="plan">更改套餐</button>' })}
        ${card('官方模型额度', `<div class="num" style="font-size:22px;font-weight:600">${fmt(account.balance)} <span class="muted" style="font-size:13px;font-weight:400">点可用</span></div>${meter(account.usedThisPeriod, Math.max(account.plan.monthlyPoints, 1), `本周期已用 ${fmt(account.usedThisPeriod)} / ${fmt(account.plan.monthlyPoints)}`)}${account.plan.monthlyPoints ? '<div style="margin-top:6px"><button class="link" data-act="reset-period">重置本周期额度</button></div>' : ''}<dl class="kv" style="margin-top:12px"><dt>今天已用</dt><dd class="num">${fmt(account.usedToday)} / ${fmt(account.limits.dailyPoints)} 点${account.usedToday ? ' <button class="link" data-act="reset-today">重置</button>' : ''}</dd><dt>限制</dt><dd>${data.limits ? '单独设置' : '跟随套餐'}：每分钟 ${account.limits.rpm} 次，同时 ${account.limits.concurrency} 个</dd>${account.debt ? `<dt>欠额</dt><dd class="down">${fmt(account.debt)} 点</dd>` : ''}</dl>`, { actions: '<button class="btn sm" data-act="refresh-period" title="补发本周期还没发的套餐点数">刷新</button><button class="btn sm" data-act="credit">调整额度</button>' })}
        ${card('同步空间', `${meter(account.storage.usedBytes, account.storage.limitBytes, `${bytes(account.storage.usedBytes)} / ${bytes(account.storage.limitBytes)}`)}<dl class="kv" style="margin-top:12px"><dt>拥有的项目</dt><dd>${data.projects.filter((p) => p.owned).length} 个</dd><dt>加入的项目</dt><dd>${data.projects.filter((p) => !p.owned).length} 个（不占自己的空间）</dd><dt>历史版本</dt><dd>保留 ${account.plan.historyDays} 天</dd></dl><div class="muted" style="margin-top:8px;font-size:12px">第一期只统计，不限制上传。</div>`)}
      </div>
      ${card('近 30 天用量', dailyChart(180), { sub: '点' })}`;
    } else if (tab === 'credits') {
      body = `${card('额度包', data.grants.length ? `<table><thead><tr><th>来源</th><th>说明</th><th class="n">总点数</th><th class="n">剩余</th><th>生效</th><th>到期</th><th>状态</th></tr></thead><tbody>${data.grants.map((g) => `<tr><td>${esc(g.label)}</td><td class="muted wrap">${esc(g.note)}</td><td class="n">${fmt(g.points)}</td><td class="n">${fmt(g.left)}</td><td class="num muted">${date(g.startsAt)}</td><td class="num muted">${date(g.expiresAt)}</td><td>${g.expired ? chip('已到期') : g.left ? chip('可用', 'ok') : chip('已用完', 'warn')}</td></tr>`).join('')}</tbody></table>` : empty('还没有额度包。'), { sub: '先扣最早到期的', flush: true, actions: '<button class="btn sm" data-act="credit">调整额度</button>' })}
      ${card('流水', data.ledger.length ? `<table><thead><tr><th>时间</th><th class="n">变化</th><th>类型</th><th>说明</th><th>操作人</th></tr></thead><tbody>${data.ledger.map((r) => `<tr><td class="num muted">${r.day ? `${r.day} 合计` : time(r.at)}</td><td class="n ${r.delta > 0 ? 'up' : ''}">${r.delta > 0 ? '+' : r.delta < 0 ? '−' : ''}${fmt(Math.abs(r.delta))}</td><td>${REASON[r.reason] ?? esc(r.reason)}</td><td class="wrap">${r.requests !== null ? `${fmt(r.requests)} 次请求` : esc(r.note)}</td><td class="muted">${esc(r.admin) || '—'}</td></tr>`).join('')}</tbody></table>` : empty('还没有流水。'), { sub: '使用按天合并，近 90 天', flush: true })}`;
    } else if (tab === 'usage') {
      body = `${card('近 30 天用量', dailyChart(220), { sub: '点' })}
      ${card('按模型', data.usage.models.length ? `<table><thead><tr><th>模型</th><th class="n">请求</th><th class="n">输入</th><th class="n">缓存命中</th><th class="n">输出</th><th class="n">点数</th></tr></thead><tbody>${data.usage.models.map((m) => `<tr><td>${esc(m.name)}</td><td class="n">${fmt(m.requests)}</td><td class="n">${short(m.input)}</td><td class="n">${short(m.cached)}</td><td class="n">${short(m.output)}</td><td class="n">${fmt(m.points)}</td></tr>`).join('')}</tbody></table>` : empty('近 30 天没有使用官方模型。'), { flush: true, sub: 'token 数，近 30 天' })}`;
    } else if (tab === 'projects') {
      body = card('项目', data.projects.length ? `<table><thead><tr><th>项目</th><th>角色</th><th class="n">成员</th><th class="n">云端大小</th><th>最近同步</th></tr></thead><tbody>${data.projects.map((p) => `<tr><td>${esc(p.name)}</td><td>${roleTag(p.role)}</td><td class="n">${p.members}</td><td class="n">${bytes(p.bytes)}${p.owned ? '' : ' <span class="muted">（不计入）</span>'}</td><td class="muted">${ago(p.syncedAt)}</td></tr>`).join('')}</tbody></table>` : empty('还没有同步过项目。'), { flush: true, sub: '后台只看得到项目名、成员和大小，看不到内容' });
    } else if (tab === 'devices') {
      body = `${card('登录', `<dl class="kv"><dt>有效的登录</dt><dd>${data.sessions.count} 个</dd><dt>最近登录</dt><dd>${time(data.sessions.lastSignIn)}</dd></dl>`, { actions: '<button class="btn sm" data-act="sign-out">全部下线</button>' })}
      ${card('官方模型令牌', data.devices.length ? `<table><thead><tr><th>设备</th><th>创建</th><th>最近使用</th><th></th></tr></thead><tbody>${data.devices.map((d) => `<tr><td>${icon('key')} ${esc(d.name)}</td><td class="muted num">${time(d.createdAt)}</td><td class="muted">${ago(d.lastUsedAt)}</td><td class="n"><button class="btn sm" data-act="revoke-device" data-id="${esc(d.id)}">吊销</button></td></tr>`).join('')}</tbody></table>` : empty('没有设备在用官方模型。'), { flush: true })}`;
    } else {
      body = card('操作记录', data.audit.length ? auditTable(data.audit) : empty('后台还没有对这个用户做过操作。'), { flush: true });
    }
    return `
      <div class="profile">
        <div class="avatar">${esc(user.name.slice(-2))}</div>
        <div><h2>${esc(user.name)} ${planChip(user.plan.id, user.plan.name)} ${statusChip(user.status)}</h2>
          <div class="muted"><span class="num" data-phone>${esc(user.phone)}</span><button class="link" data-act="reveal">${icon('eye')} 显示</button><span>·</span><span class="num">${esc(user.id)}</span><span>·</span><span>注册于 ${date(user.createdAt)}</span><span>·</span><span>最近活跃 ${ago(user.lastActiveAt)}</span></div>
          ${user.status === 'disabled' ? `<div class="muted">停用原因：${esc(user.disabledReason)}</div>` : ''}
        </div>
        <span style="flex:1"></span>
        <button class="btn" data-act="credit">调整额度</button>
        <button class="btn" data-act="plan">更改套餐</button>
        <button class="btn" data-act="limits">单独限制</button>
        <button class="btn" data-act="sign-out">强制下线</button>
        ${user.status === 'active' ? '<button class="btn danger" data-act="disable">停用</button>' : '<button class="btn" data-act="enable">恢复</button>'}
      </div>
      <div class="tabs">${tabs.map(([key, label]) => `<button class="${tab === key ? 'on' : ''}" data-act="set" data-key="tab" data-value="${key}">${label}</button>`).join('')}</div>
      ${body}`;
  },
  act: {
    async reveal(_el, ctx) {
      ctx.dialog(frame('显示完整手机号', '<div class="form-row"><label>原因（会记入审计）</label><input class="text" name="reason" placeholder="例如：核实用户身份"></div>', '<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="do-reveal">显示</button>'));
    },
    async 'do-reveal'(_el, ctx) {
      const { phone } = await post(`/users/${encodeURIComponent(ctx.route.id)}/reveal`, { reason: fields().reason });
      ctx.close();
      document.querySelector('[data-phone]').textContent = phone;
    },
    credit(_el, ctx) {
      const balance = ctx.data.account.balance;
      ctx.dialog(
        frame(
          `调整额度 · ${esc(ctx.data.user.name)}`,
          `<div class="form-2"><div class="form-row"><label>调整方式</label><select class="text" name="sign" data-live><option value="1">增加</option><option value="-1">扣减</option></select></div>
           <div class="form-row"><label>点数</label><input class="text num" name="points" value="200" data-live></div></div>
           <div class="form-row"><label>有效期（只对增加有效）</label><select class="text" name="days"><option value="30">30 天</option><option value="90" selected>90 天</option><option value="365">365 天</option></select></div>
           <div class="form-row"><label>原因（必填，会记入审计）</label><select class="text" name="reason"><option>同步或服务故障补偿</option><option>活动奖励</option><option>误扣退回</option><option>合作赠送</option><option>其他</option></select></div>
           <div class="form-row"><label>备注</label><textarea class="text" name="note" placeholder="写清楚为什么调整，之后查账用"></textarea></div>
           <div class="preview" data-preview data-balance="${balance}"></div>`,
          '<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="do-credit">确认调整</button>',
        ),
      );
      userPage.live();
    },
    async 'do-credit'(_el, ctx) {
      const f = fields();
      const points = Number(f.points);
      if (!Number.isInteger(points) || points <= 0) throw new Error('点数要是正整数。');
      if (f.reason === '其他' && !f.note.trim()) throw new Error('选“其他”时请写备注。');
      await post(`/users/${encodeURIComponent(ctx.route.id)}/credits`, { delta: points * Number(f.sign), days: Number(f.days), reason: f.reason, note: f.note });
      ctx.close();
      toast(`已${Number(f.sign) > 0 ? '增加' : '扣减'} ${fmt(points)} 点，并记入审计`);
      await ctx.reload();
    },
    async 'refresh-period'(_el, ctx) {
      const { added } = await post(`/users/${encodeURIComponent(ctx.route.id)}/refresh-period`);
      toast(added > 0 ? `已补发本周期 ${fmt(added)} 点` : '本周期的点数已经发过');
      await ctx.reload();
    },
    'reset-period'(_el, ctx) {
      const { account, user } = ctx.data;
      ctx.dialog(
        frame(
          `重置本周期额度 · ${esc(user.name)}`,
          `<div>把本周期（${date(account.period.start)} 至 ${date(account.period.end)}）的套餐点数恢复到满额 ${fmt(account.plan.monthlyPoints)} 点。注册赠送、兑换码和人工调整的额度包不变。</div>
           <div class="form-row"><label>原因（必填，会记入审计）</label><input class="text" name="reason" placeholder="例如：服务故障补偿"></div>`,
          '<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="do-reset-period">重置</button>',
        ),
      );
    },
    async 'do-reset-period'(_el, ctx) {
      const { added } = await post(`/users/${encodeURIComponent(ctx.route.id)}/reset-period`, { reason: fields().reason });
      ctx.close();
      toast(added ? `已恢复 ${fmt(added)} 点，并记入审计` : '本周期的点数本来就是满的');
      await ctx.reload();
    },
    'reset-today'(_el, ctx) {
      const { account, user } = ctx.data;
      ctx.dialog(
        frame(
          `重置今日用量 · ${esc(user.name)}`,
          `<div>今天已用的 ${fmt(account.usedToday)} 点不再计入单日上限，用户今天可以重新用满 ${fmt(account.limits.dailyPoints)} 点。点数余额、用量统计和流水都不变。</div>
           <div class="form-row"><label>原因（必填，会记入审计）</label><input class="text" name="reason" placeholder="例如：赶论文截止，临时放宽"></div>`,
          '<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="do-reset-today">重置</button>',
        ),
      );
    },
    async 'do-reset-today'(_el, ctx) {
      await post(`/users/${encodeURIComponent(ctx.route.id)}/reset-today`, { reason: fields().reason });
      ctx.close();
      toast('已重置今日用量，并记入审计');
      await ctx.reload();
    },
    plan(_el, ctx) {
      ctx.dialog(planDialog(ctx.data.user.name, ctx.state.plans));
    },
    async 'do-plan'(_el, ctx) {
      await submitPlan(ctx.route.id);
      ctx.close();
      toast('已更新套餐，已生成订单并记入审计');
      await ctx.reload();
    },
    limits(_el, ctx) {
      const l = ctx.data.limits;
      const a = ctx.data.account.limits;
      ctx.dialog(
        frame(
          `单独限制 · ${esc(ctx.data.user.name)}`,
          `<div class="note">${icon('info')}<span>只覆盖这个用户的套餐默认值，例如用量异常时临时调低，或给合作课题组调高。留空的项跟随套餐。</span></div>
           <div class="form-3"><div class="form-row"><label>每分钟请求</label><input class="text num" name="rpm" value="${l?.rpm ?? ''}" placeholder="${a.rpm}"></div><div class="form-row"><label>同时进行</label><input class="text num" name="concurrency" value="${l?.concurrency ?? ''}" placeholder="${a.concurrency}"></div><div class="form-row"><label>单日上限（点）</label><input class="text num" name="dailyPoints" value="${l?.dailyPoints ?? ''}" placeholder="${a.dailyPoints}"></div></div>
           <div class="form-row"><label>多久后恢复套餐默认值</label><select class="text" name="days"><option value="7">7 天后</option><option value="30">30 天后</option><option value="">不恢复</option></select></div>
           <div class="form-row"><label>原因（必填）</label><input class="text" name="reason" value="${esc(l?.reason ?? '')}"></div>`,
          `${l ? '<button class="btn" data-act="clear-limits">恢复套餐默认值</button>' : ''}<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="do-limits">保存</button>`,
        ),
      );
    },
    async 'do-limits'(_el, ctx) {
      const f = fields();
      const value = (v) => (v.trim() === '' ? null : Number(v));
      await post(`/users/${encodeURIComponent(ctx.route.id)}/limits`, { rpm: value(f.rpm), concurrency: value(f.concurrency), dailyPoints: value(f.dailyPoints), days: f.days ? Number(f.days) : null, reason: f.reason });
      ctx.close();
      toast('已保存，立即生效');
      await ctx.reload();
    },
    async 'clear-limits'(_el, ctx) {
      await post(`/users/${encodeURIComponent(ctx.route.id)}/limits`, { clear: true });
      ctx.close();
      toast('已恢复套餐默认值');
      await ctx.reload();
    },
    disable(_el, ctx) {
      ctx.dialog(
        frame(
          `停用账号 · ${esc(ctx.data.user.name)}`,
          `<div class="note warn">${icon('alert')}<span>停用后这个账号的所有设备立即下线，不能登录、同步和使用官方模型。云端数据保留，团队项目里的其他成员不受影响。</span></div><div class="form-row"><label>原因（必填，用户登录时会看到）</label><input class="text" name="reason" placeholder="例如：违反用户协议"></div>`,
          '<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="do-disable">停用</button>',
        ),
      );
    },
    async 'do-disable'(_el, ctx) {
      await post(`/users/${encodeURIComponent(ctx.route.id)}/status`, { disabled: true, reason: fields().reason });
      ctx.close();
      toast('已停用，所有设备已下线');
      await ctx.reload();
    },
    async enable(_el, ctx) {
      await post(`/users/${encodeURIComponent(ctx.route.id)}/status`, { disabled: false });
      toast('已恢复');
      await ctx.reload();
    },
    'sign-out'(_el, ctx) {
      ctx.dialog(frame('强制下线', `<div>${esc(ctx.data.user.name)} 的所有设备会退出登录，官方模型令牌一并吊销。用户重新登录即可继续使用。</div>`, '<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="do-sign-out">下线</button>'));
    },
    async 'do-sign-out'(_el, ctx) {
      const result = await post(`/users/${encodeURIComponent(ctx.route.id)}/sign-out`);
      ctx.close();
      toast(`已让 ${result.sessions} 个登录下线，吊销 ${result.modelTokens} 个模型令牌`);
      await ctx.reload();
    },
    async 'revoke-device'(el, ctx) {
      await del(`/users/${encodeURIComponent(ctx.route.id)}/devices/${encodeURIComponent(el.dataset.id)}`);
      toast('已吊销这台设备的模型令牌');
      await ctx.reload();
    },
  },
  live() {
    const preview = document.querySelector('#layer [data-preview]');
    if (!preview) return;
    const f = fields();
    const points = Number(f.points) || 0;
    const after = Number(preview.dataset.balance) + Number(f.sign) * points;
    preview.innerHTML = `调整后可用 <b class="num">${fmt(after)}</b> 点。${Number(f.sign) > 0 ? '作为一个单独的额度包发放，按到期时间排进扣费顺序。' : '从最早到期的额度包里扣，不能扣到负数。'}`;
  },
};

/** Opening or changing a plan; shared with "手动开通" on the orders page. */
export function planDialog(name, plans, lookup = false) {
  const options = plans.filter((plan) => plan.active || plan.id === 'free').map((plan) => `<option value="${esc(plan.id)}">${esc(plan.name)}${plan.priceMonth ? `（¥${plan.priceMonth / 100}/月）` : ''}</option>`).join('');
  return frame(
    lookup ? '手动开通' : `更改套餐 · ${esc(name)}`,
    `${lookup ? '<div class="form-row"><label>用户手机号</label><div class="code-row" style="display:flex;gap:8px"><input class="text num" name="phone" placeholder="11 位手机号"><button class="btn" data-act="lookup">查找</button></div><div class="hint" data-found></div><input type="hidden" name="userId"></div>' : ''}
     <div class="form-2"><div class="form-row"><label>套餐</label><select class="text" name="planId">${options}</select></div>
     <div class="form-row"><label>时长</label><select class="text" name="months"><option value="1">1 个月</option><option value="3">3 个月</option><option value="12" selected>12 个月</option></select></div></div>
     <div class="form-2"><div class="form-row"><label>收款方式</label><select class="text" name="method"><option>对公转账</option><option>微信转账</option><option>赠送</option></select></div>
     <div class="form-row"><label>金额（元）</label><input class="text num" name="amount" value="0"></div></div>
     <div class="form-row"><label>备注（会记入审计和订单）</label><textarea class="text" name="note" placeholder="例如：转账回单号"></textarea></div>
     <div class="note">${icon('info')}<span>已有同一套餐时在到期后顺延；选“免费”会立刻结束付费套餐，本周期已发的点数保留到周期结束。</span></div>`,
    `<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="do-plan">确定</button>`,
  );
}
export async function submitPlan(userId) {
  const f = fields();
  const id = userId || f.userId;
  if (!id) throw new Error('请先查找用户。');
  const amount = Number(f.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('金额无效。');
  await post(`/users/${encodeURIComponent(id)}/plan`, { planId: f.planId, months: Number(f.months), method: f.method, amount, note: f.note });
}

export const auditTable = (entries) =>
  `<table><thead><tr><th>时间</th><th>管理员</th><th>操作</th><th>对象</th><th>内容</th><th>原因</th><th>IP</th></tr></thead><tbody>${entries
    .map((a) => `<tr><td class="num muted">${time(a.at)}</td><td>${esc(a.admin)}</td><td><b>${esc(a.action)}</b></td><td>${esc(a.target) || '—'}</td><td class="json">${a.after ? esc(JSON.stringify(a.after)) : '—'}</td><td class="wrap muted">${esc(a.reason) || '—'}</td><td class="num muted">${esc(a.ip)}</td></tr>`)
    .join('')}</tbody></table>`;

// ---------- Errors ----------
export const errorsPage = {
  title: () => '错误',
  load: (route) => get(`/errors${route.query.all === '1' ? '?all=1' : ''}`),
  view(data) {
    const rows = data.errors
      .map(
        (e) => `<tr><td class="num muted">${ago(e.lastAt)}</td><td class="wrap"><details class="error-detail"><summary><b>${esc(e.message)}</b></summary><div class="json">${esc(e.source)}${e.page ? ` · ${esc(e.page)}` : ''} · 首次 ${time(e.firstAt)}</div>${e.stack ? `<pre class="error-stack">${esc(e.stack)}</pre>` : ''}</details></td><td class="num">${esc(e.version)}</td><td>${esc(e.platform)}</td><td class="n">${fmt(e.count)}</td><td class="n">${fmt(e.devices)}</td><td>${e.userId ? `<a href="#/users/${encodeURIComponent(e.userId)}">${esc(e.user)}</a>` : '—'}</td><td class="n">${e.resolved ? chip('已处理') : `<button class="btn sm" data-act="resolve" data-id="${esc(e.id)}">已处理</button>`}</td></tr>`,
      )
      .join('');
    const table = `<table><thead><tr><th>最近</th><th>错误</th><th>版本</th><th>平台</th><th class="n">次数</th><th class="n">设备</th><th>最近用户</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    return `<div class="toolbar">${seg('all', data.all ? '1' : '0', [['0', '未处理'], ['1', '全部']])}<span class="muted">应用里没接住的错误，同一错误合并计数；再次出现会重新变成未处理。用户可以在设置里关掉上报。</span></div>${card('错误', data.errors.length ? table : empty(data.all ? '还没有收到错误报告。' : '没有未处理的错误。'), { flush: true })}`;
  },
  act: {
    async resolve(el, ctx) {
      await post(`/errors/${encodeURIComponent(el.dataset.id)}/resolve`);
      toast('已标记为处理');
      await ctx.reload();
    },
  },
};

// ---------- Teams ----------
function teamGraph(list) {
  return () => {
    const shown = list.slice(0, 12);
    const columns = 3;
    const cell = 260;
    const height = Math.ceil(shown.length / columns) * cell;
    let svg = '';
    shown.forEach((team, index) => {
      const cx = (index % columns) * cell + cell / 2;
      const cy = Math.floor(index / columns) * cell + cell / 2 + 10;
      const others = team.members.filter((m) => m.id !== team.ownerId);
      const ring = Math.min(86, 40 + others.length * 6);
      const radius = (m) => Math.min(18, 6 + Math.sqrt(m.points) / 5.5);
      const position = new Map();
      team.members.forEach((m) => {
        const k = others.indexOf(m);
        const angle = -Math.PI / 2 + (2 * Math.PI * k) / Math.max(1, others.length);
        position.set(m.id, k < 0 ? [cx, cy] : [cx + ring * Math.cos(angle), cy + ring * Math.sin(angle)]);
      });
      svg += `<circle class="hull" data-go="#/teams/${encodeURIComponent(team.id)}" data-hover-team="${esc(team.id)}" cx="${cx}" cy="${cy}" r="${ring + 30}"/>`;
      svg += `<text class="cl" data-go="#/teams/${encodeURIComponent(team.id)}" x="${cx}" y="${cy - ring - 38}" text-anchor="middle">${esc(team.name)}<tspan> · ${team.members.length} 人</tspan></text>`;
      for (const edge of team.edges) {
        const a = position.get(edge.a);
        const b = position.get(edge.b);
        if (a && b) svg += `<line class="edge" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke-width="${0.8 + edge.weight * 1.1}"/>`;
      }
      for (const m of team.members) {
        const [x, y] = position.get(m.id);
        const id = tip(`<div class="h">${esc(m.name)}${m.id === team.ownerId ? ' · 团队所有者' : ''}</div>${tipRow('', '套餐', esc(m.planName))}${tipRow('', '本月用量', `${fmt(m.points)} 点`)}`);
        svg += `<circle class="node ${m.plan === 'free' ? 'free' : 'pro'} ${m.id === team.ownerId ? 'owner' : ''}" data-tip="${id}" data-go="#/users/${encodeURIComponent(m.id)}" cx="${x}" cy="${y}" r="${radius(m)}"/>`;
        svg += `<text class="nm" x="${x}" y="${y + radius(m) + 12}" text-anchor="middle">${esc(m.name)}</text>`;
      }
    });
    return `<div class="graph"><svg viewBox="0 0 ${columns * cell} ${height}" style="height:auto">${svg}</svg></div>`;
  };
}

export const teamsPage = {
  title: () => '团队',
  load: () => get('/teams'),
  view(data, route) {
    const list = data.teams;
    const view = route.query.view ?? 'graph';
    const freeOwners = list.filter((team) => team.ownerPlan === 'free').length;
    const header = `
      <div class="tiles" style="grid-template-columns:repeat(4,1fr)">
        ${tile('团队', list.length, '从共同的项目推断')}
        ${tile('团队项目', list.reduce((sum, team) => sum + team.projects.length, 0), '有其他成员的项目')}
        ${tile('团队成员', list.reduce((sum, team) => sum + team.members.length, 0))}
        ${tile('所有者是免费版', freeOwners, freeOwners ? '可以介绍课题组版' : '')}
      </div>
      <div class="toolbar">${seg('view', view, [['graph', '关系图'], ['list', '列表']])}<span class="grow"></span><span class="muted">课题组版上线后，课题组按组织显示</span></div>`;
    if (!list.length) return header + card('团队', empty('还没有人和别人共享项目。'));
    const table = `<table><thead><tr><th>团队</th><th>所有者套餐</th><th>成员</th><th class="n">团队项目</th><th class="n">云端大小</th><th class="n">本月用量</th><th>最近活跃</th></tr></thead><tbody>${list
      .map((team) => `<tr class="click" data-go="#/teams/${encodeURIComponent(team.id)}"><td><b>${esc(team.name)}</b></td><td>${planChip(team.ownerPlan, team.ownerPlanName)}</td><td>${team.members.length} 人</td><td class="n">${team.projects.length}</td><td class="n">${bytes(team.bytes)}</td><td class="n">${fmt(team.points)} 点</td><td class="muted">${ago(team.lastActiveAt)}</td></tr>`)
      .join('')}</tbody></table>`;
    if (view === 'list') return header + card('团队', table, { flush: true });
    return (
      header +
      `<div class="graph-wrap">
        ${card('协作关系图', `<div class="legend"><span><i style="background:var(--s1);border-radius:50%"></i>付费套餐</span><span><i style="background:var(--text-4);border-radius:50%"></i>免费</span><span><i style="border:2px solid var(--text);border-radius:50%;background:none"></i>团队所有者</span><span class="muted">点越大，本月 AI 用量越多；线越粗，共同的项目越多${list.length > 12 ? '；图里只画最大的 12 个团队' : ''}</span></div>${chart(teamGraph(list))}`, { sub: '每个点是一个人，两人在同一个项目里就连线' })}
        ${card('团队', `<div class="team-list">${list.map((team) => `<button class="team" data-go="#/teams/${encodeURIComponent(team.id)}" data-hover-team="${esc(team.id)}"><b>${esc(team.name)}</b> ${planChip(team.ownerPlan, team.ownerPlanName)}<div class="muted">${team.members.length} 人 · ${team.projects.length} 个团队项目 · ${bytes(team.bytes)}</div><div class="muted">本月 ${fmt(team.points)} 点 · 最近活跃 ${ago(team.lastActiveAt)}</div></button>`).join('')}</div>`, { flush: true })}
      </div>`
    );
  },
};

const PARTS = ['文献', '代码', '文档', '笔记图片', '其他'];
export const teamPage = {
  title: (data) => `<div class="crumb"><button data-go="#/teams">团队</button>${icon('right')}<h1>${esc(data?.name ?? '')}</h1></div>`,
  load: (route) => get(`/teams/${encodeURIComponent(route.id)}`),
  view(t) {
    const owner = t.members.find((m) => m.id === t.ownerId);
    const all = t.heat.flat().filter((v) => v > 0).sort((a, b) => a - b);
    const q = (p) => all[Math.floor(p * (all.length - 1))] ?? 1;
    const steps = [q(0.2), q(0.4), q(0.6), q(0.8)];
    const levelOf = (v) => (v === 0 ? 0 : 1 + steps.filter((s) => v > s).length);
    const heat = `<div class="heat" style="grid-template-columns:auto repeat(${t.days.length},1fr)">
      ${t.members.map((m, i) => `<div class="lbl">${esc(m.name)}</div>${t.heat[i].map((v, j) => `<div class="cell" style="background:var(--seq${levelOf(v)})" data-tip="${tip(`<div class="h">${esc(m.name)} · ${md(t.days[j])}</div>${tipRow('', '同步的改动', `${v} 处`)}`)}"></div>`).join('')}`).join('')}
      <div></div>${t.days.map((d, j) => `<div class="axis">${j % 5 === 4 || j === 0 ? md(d) : ''}</div>`).join('')}
    </div><div class="ramp" style="margin-top:10px">少 ${[0, 1, 2, 3, 4, 5].map((k) => `<i style="background:var(--seq${k})"></i>`).join('')} 多<span class="muted" style="margin-left:12px">每格是一个人一天同步上去的改动数</span></div>`;
    const series = PARTS.map((name, i) => ({ key: name, name, color: `var(--s${i + 1})` }));
    const crowded = t.projects.filter((p) => t.ownerLimits.maxMembers && Object.keys(p.roles).length >= t.ownerLimits.maxMembers);
    const matrix = `<table class="matrix"><thead><tr><th>成员</th>${t.projects.map((p) => `<th>${esc(p.name)}</th>`).join('')}<th class="n">本月用量</th></tr></thead><tbody>${t.members
      .map((m) => `<tr><td><b>${esc(m.name)}</b> ${planChip(m.plan, m.planName)}</td>${t.projects.map((p) => `<td>${p.roles[m.id] ? roleTag(p.roles[m.id]) : '<span class="muted">—</span>'}</td>`).join('')}<td class="n">${fmt(m.points)} 点</td></tr>`)
      .join('')}</tbody></table>`;
    const ownedBytes = t.projects.filter((p) => p.ownerId === t.ownerId).reduce((sum, p) => sum + p.bytes, 0);
    return `
      <div class="profile"><div class="avatar">${icon('team')}</div><div><h2>${esc(t.name)}</h2><div class="muted">所有者 <button class="link" data-go="#/users/${encodeURIComponent(t.ownerId)}">${esc(owner?.name ?? '')}（${esc(owner?.phone ?? '')}）</button> · ${esc(t.ownerPlanName)}</div></div></div>
      <div class="tiles" style="grid-template-columns:repeat(4,1fr)">
        ${tile('成员', `${t.members.length} 人`, t.invites.length ? `另有 ${t.invites.length} 个邀请未接受` : '没有待接受的邀请')}
        ${tile('团队项目', t.projects.length)}
        ${tile('云端大小', bytes(t.bytes), `所有者的项目 ${bytes(ownedBytes)} / ${bytes(t.ownerLimits.storageBytes)}`)}
        ${tile('本月 AI 用量', `${fmt(t.points)} 点`, '成员各自扣自己的额度')}
      </div>
      ${crowded.length && t.ownerPlan === 'free' ? `<div class="note warn">${icon('alert')}<span>所有者是免费版，${crowded.map((p) => `“${esc(p.name)}”`).join('、')}已到每个项目 ${t.ownerLimits.maxMembers} 人的上限。这个团队适合介绍课题组版。</span></div>` : ''}
      ${card('成员 × 项目', matrix + (t.invites.length ? `<div class="card-body muted">待接受的邀请：${t.invites.map((i) => `${esc(i.phone)}（${esc(i.project)} · ${ROLE[i.role] ?? esc(i.role)}）`).join('、')}</div>` : ''), { flush: true, sub: '每格是这个人在这个项目里的角色' })}
      ${card('近 30 天活动', heat)}
      <div class="grid g2">
        ${card('成员本月用量', chart(hbarChart({ items: [...t.members].sort((a, b) => b.points - a.points).map((m) => ({ label: m.name, value: m.points })) })), { sub: '点' })}
        ${card('云端空间构成', legend(series) + chart(stackBarH({ items: t.composition.map((c) => ({ label: c.name, ...c.parts })), series })), { sub: '按项目' })}
      </div>`;
  },
};
