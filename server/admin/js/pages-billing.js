// Billing pages: plans, redeem codes, models and channels, usage, orders and the audit log.

import { get, post, put } from './api.js';
import {
  bytes, card, chart, chip, date, download, empty, esc, fields, fmt, frame, icon, legend, md, meter, money,
  rowsFor, seg, seriesFor, short, stackChart, tile, time, toast,
} from './ui.js';
import { auditTable, planDialog, submitPlan } from './pages-ops.js';

const yuan = (fen) => (fen ? `¥${(fen / 100).toLocaleString('en-US')}` : '0');

// ---------- Plans ----------
export const plansPage = {
  title: () => '套餐与额度',
  load: () => get('/plans'),
  view(data) {
    return `
      ${card('套餐', `<table><thead><tr><th>套餐</th><th class="n">月付</th><th class="n">年付</th><th class="n">每月点数</th><th class="n">单日上限</th><th>同步空间</th><th>项目成员上限</th><th>历史版本</th><th>限制</th><th>状态</th><th></th></tr></thead><tbody>${data.plans
        .map((p) => `<tr><td><b>${esc(p.name)}</b></td><td class="n">${yuan(p.priceMonth)}</td><td class="n">${yuan(p.priceYear)}</td><td class="n">${fmt(p.monthlyPoints)}</td><td class="n">${fmt(p.dailyPoints)}</td><td>${bytes(p.storageBytes)}</td><td>${p.maxMembers ? `${p.maxMembers} 人` : '不限'}</td><td>${p.historyDays} 天</td><td class="muted">每分钟 ${p.rpm} · 同时 ${p.concurrency}</td><td>${p.active ? chip('上架', 'ok') : chip('未上架')}</td><td class="n"><button class="btn sm" data-act="edit" data-id="${esc(p.id)}">编辑</button></td></tr>`)
        .join('')}</tbody></table>`, { flush: true, sub: '可用的模型在“模型与渠道”里按模型设置' })}
      ${card('扣费和限制', `<div class="rules">
        <div class="rule"><div class="k">计量单位</div><div class="v">1 点 = ¥0.01（按售价）</div></div>
        <div class="rule"><div class="k">扣费顺序</div><div class="v">先扣最早到期的额度包</div></div>
        <div class="rule"><div class="k">余额不足</div><div class="v">拦新请求，进行中的做完；欠额下次先抵</div></div>
        <div class="rule"><div class="k">失败的请求</div><div class="v">上游报错不扣；中途停止按已生成的扣</div></div>
        <div class="rule"><div class="k">新用户</div><div class="v">注册送 1,000 点，30 天有效</div></div>
        <div class="rule"><div class="k">AI 对话内容</div><div class="v">只在用户电脑上，服务器只记 token 数</div></div>
      </div>`)}
      ${card('加油包', empty('第二期接入在线支付后上架：500 点 ¥5、2,000 点 ¥19、5,000 点 ¥45，12 个月有效。现在用兑换码或“调整额度”代替。'))}`;
  },
  act: {
    edit(el, ctx) {
      const p = ctx.data.plans.find((plan) => plan.id === el.dataset.id);
      ctx.dialog(
        frame(
          `编辑套餐 · ${esc(p.name)}`,
          `<input type="hidden" name="id" value="${esc(p.id)}">
           <div class="form-3"><div class="form-row"><label>名称</label><input class="text" name="name" value="${esc(p.name)}"></div><div class="form-row"><label>月付（元）</label><input class="text num" name="priceMonth" value="${p.priceMonth / 100}"></div><div class="form-row"><label>年付（元）</label><input class="text num" name="priceYear" value="${p.priceYear / 100}"></div></div>
           <div class="form-3"><div class="form-row"><label>每月点数</label><input class="text num" name="monthlyPoints" value="${p.monthlyPoints}"></div><div class="form-row"><label>单日上限（点）</label><input class="text num" name="dailyPoints" value="${p.dailyPoints}"></div><div class="form-row"><label>同步空间（GB）</label><input class="text num" name="storageGb" value="${p.storageBytes / 1024 ** 3}"></div></div>
           <div class="form-3"><div class="form-row"><label>项目成员上限（留空不限）</label><input class="text num" name="maxMembers" value="${p.maxMembers ?? ''}"></div><div class="form-row"><label>历史版本（天）</label><input class="text num" name="historyDays" value="${p.historyDays}"></div><div class="form-row"><label>单次最大输出（token）</label><input class="text num" name="maxOutputTokens" value="${p.maxOutputTokens}"></div></div>
           <div class="form-3"><div class="form-row"><label>每分钟请求</label><input class="text num" name="rpm" value="${p.rpm}"></div><div class="form-row"><label>同时进行</label><input class="text num" name="concurrency" value="${p.concurrency}"></div><div class="form-row"><label>状态</label><label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''} ${p.id === 'free' ? 'disabled' : ''}> 上架</label></div></div>
           <div class="note">${icon('info')}<span>点数和价格从下一个计费周期生效，正在当前周期的用户保持原样；限制立即生效。下架只停止出售，已订阅的用户到期前不受影响。</span></div>`,
          '<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="save">保存</button>',
          true,
        ),
      );
    },
    async save(_el, ctx) {
      const f = fields();
      const whole = (v, name) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw new Error(`${name}无效。`);
        return n;
      };
      await put(`/plans/${encodeURIComponent(f.id)}`, {
        name: f.name,
        priceMonth: Math.round(whole(f.priceMonth, '月付') * 100),
        priceYear: Math.round(whole(f.priceYear, '年付') * 100),
        monthlyPoints: whole(f.monthlyPoints, '每月点数'),
        dailyPoints: whole(f.dailyPoints, '单日上限'),
        storageBytes: Math.round(whole(f.storageGb, '同步空间') * 1024 ** 3),
        maxMembers: f.maxMembers.trim() ? whole(f.maxMembers, '成员上限') : null,
        historyDays: whole(f.historyDays, '历史版本'),
        maxOutputTokens: whole(f.maxOutputTokens, '最大输出'),
        rpm: whole(f.rpm, '每分钟请求'),
        concurrency: whole(f.concurrency, '同时进行'),
        ...(f.id === 'free' ? {} : { active: f.active }),
      });
      ctx.close();
      toast('已保存套餐');
      await ctx.reload();
    },
  },
};

// ---------- Redeem codes ----------
export const codesPage = {
  title: () => '兑换码',
  load: () => get('/codes'),
  view(data) {
    return `
      <div class="toolbar"><span class="muted">兑换码只在生成时显示一次，服务器只保存摘要。同一批里每个账号只能兑换一个。</span><span class="grow"></span><button class="btn primary" data-act="new">${icon('plus')}生成兑换码</button></div>
      ${card('批次', data.batches.length ? `<table><thead><tr><th>批次</th><th>面值</th><th class="n">数量</th><th>已兑换</th><th>兑换截止</th><th>创建</th><th>状态</th><th></th></tr></thead><tbody>${data.batches
        .map((b) => {
          const over = b.voided || new Date(b.redeemUntil) <= new Date();
          return `<tr><td><b>${esc(b.name)}</b></td><td>${esc(b.face)}</td><td class="n">${b.count}</td><td>${meter(b.used, b.count, `${b.used} / ${b.count}`)}</td><td class="num">${date(b.redeemUntil)}</td><td class="muted">${date(b.createdAt)} · ${esc(b.creator)}</td><td>${b.voided ? chip('已作废') : over ? chip('已截止') : chip('有效', 'ok')}</td><td class="n">${over ? '' : `<button class="btn sm danger" data-act="void" data-id="${esc(b.id)}" data-name="${esc(b.name)}">作废</button>`}</td></tr>`;
        })
        .join('')}</tbody></table>` : empty('还没有生成过兑换码。'), { flush: true })}`;
  },
  act: {
    new(_el, ctx) {
      const plans = ctx.state.plans.filter((plan) => plan.id !== 'free');
      const until = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10);
      ctx.dialog(
        frame(
          '生成兑换码',
          `<div class="form-row"><label>批次名称</label><input class="text" name="name" placeholder="例如：12 月学院讲座"></div>
           <div class="form-row"><label>面值</label><select class="text" name="kind" data-live><option value="plan">套餐时长</option><option value="points">点数</option></select></div>
           <div class="form-2" data-kind="plan"><div class="form-row"><label>套餐</label><select class="text" name="planId">${plans.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.active ? '' : '（未上架）'}</option>`).join('')}</select></div><div class="form-row"><label>时长</label><select class="text" name="months"><option value="1">1 个月</option><option value="3">3 个月</option><option value="12">12 个月</option></select></div></div>
           <div class="form-2" data-kind="points" hidden><div class="form-row"><label>点数</label><input class="text num" name="points" value="2000"></div><div class="form-row"><label>兑换后有效期</label><select class="text" name="validDays"><option value="30">30 天</option><option value="90" selected>90 天</option><option value="365">365 天</option></select></div></div>
           <div class="form-2"><div class="form-row"><label>数量（最多 1000）</label><input class="text num" name="count" value="50"></div><div class="form-row"><label>兑换截止</label><input class="text num" type="date" name="redeemUntil" value="${until}"></div></div>`,
          '<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="create">生成</button>',
        ),
      );
    },
    async create(_el, ctx) {
      const f = fields();
      const result = await post('/codes', {
        name: f.name,
        kind: f.kind,
        planId: f.planId,
        months: Number(f.months),
        points: Number(f.points),
        validDays: Number(f.validDays),
        count: Number(f.count),
        redeemUntil: `${f.redeemUntil}T23:59:59+08:00`,
      });
      ctx.state.lastCodes = { name: f.name, codes: result.codes };
      ctx.dialog(
        frame(
          '兑换码已生成',
          `<div class="note warn">${icon('alert')}<span>兑换码只显示这一次，关闭前请导出。之后后台也看不到明文。</span></div><div class="codes">${result.codes.slice(0, 12).map(esc).join('<br>')}${result.codes.length > 12 ? `<br><span class="muted">… 共 ${result.codes.length} 个，导出后可以看到全部</span>` : ''}</div>`,
          `<button class="btn" data-act="export">${icon('download')}导出 CSV</button><button class="btn primary" data-act="close">完成</button>`,
        ),
      );
      await ctx.reload(false);
    },
    export(_el, ctx) {
      const { name, codes } = ctx.state.lastCodes ?? { codes: [] };
      download(`兑换码-${name}.csv`, `批次,兑换码\n${codes.map((code) => `${name},${code}`).join('\n')}`);
    },
    void(el, ctx) {
      ctx.dialog(frame('作废兑换码', `“${esc(el.dataset.name)}”里还没兑换的码会全部失效，已兑换的不受影响。`, `<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="do-void" data-id="${esc(el.dataset.id)}">作废</button>`));
    },
    async 'do-void'(el, ctx) {
      await post(`/codes/${encodeURIComponent(el.dataset.id)}/void`);
      ctx.close();
      toast('未兑换的兑换码已作废');
      await ctx.reload();
    },
  },
  live() {
    const kind = fields().kind;
    document.querySelectorAll('#layer [data-kind]').forEach((element) => (element.hidden = element.dataset.kind !== kind));
  },
};

// ---------- Models and channels ----------
const MIX = { input: 0.4, cached: 0.52, output: 0.08 };
// Early pricing: the cost plus 10%, as the server's billing/pricing.mjs; 1 point = ¥0.01.
const MARKUP = 1.1;
const MIN_MARGIN = Math.floor((1 - 1 / MARKUP) * 100);
const autoPrice = (cost) => {
  const value = Number(cost);
  return Number.isFinite(value) && value > 0 ? Math.ceil(Number((value * 100 * MARKUP).toFixed(6))) : 0;
};
const PRICE_KEYS = ['Input', 'Cached', 'Output'];
const typical = (m) => {
  const sale = (MIX.input * m.priceInput + MIX.cached * m.priceCached + MIX.output * m.priceOutput) / 100;
  const cost = MIX.input * m.costInput + MIX.cached * m.costCached + MIX.output * m.costOutput;
  return { sale, cost, margin: sale > 0 ? Math.round((1 - cost / sale) * 100) : null };
};
const PLAN_SHORT = { free: '免费', pro: '专业版', team: '课题组版' };

export const modelsPage = {
  title: () => '模型与渠道',
  load: () => get('/models'),
  view(data, route) {
    const tab = route.query.tab ?? 'models';
    const tabs = `<div class="tabs"><button class="${tab === 'models' ? 'on' : ''}" data-act="set" data-key="tab" data-value="models">模型</button><button class="${tab === 'channels' ? 'on' : ''}" data-act="set" data-key="tab" data-value="channels">渠道</button></div>`;
    const channelName = new Map(data.channels.map((c) => [c.id, c.name]));
    if (tab === 'channels')
      return `${tabs}<div class="toolbar"><span class="muted">渠道是上游的模型服务。密钥加密保存，只显示末四位，能改不能看。Agent 需要渠道支持 Responses 接口。</span><span class="grow"></span><button class="btn primary" data-act="channel">${icon('plus')}新增渠道</button></div>
        ${card('渠道', data.channels.length ? `<table><thead><tr><th>渠道</th><th>地址</th><th>密钥</th><th>服务的模型</th><th class="n">24 小时请求</th><th class="n">错误率</th><th class="n">中位耗时</th><th>状态</th><th></th></tr></thead><tbody>${data.channels
          .map((c) => {
            const h = c.health;
            const served = data.models.filter((m) => m.channelId === c.id || m.backupChannelId === c.id).map((m) => esc(m.name) + (m.backupChannelId === c.id ? '（备用）' : ''));
            return `<tr><td><b>${esc(c.name)}</b></td><td class="muted wrap">${esc(c.endpoint)}${c.chatEndpoint ? `<br>${esc(c.chatEndpoint)}` : ''}</td><td class="num">${icon('key')} ····${esc(c.keyHint)}</td><td class="wrap">${served.join('、') || '—'}</td><td class="n">${h ? fmt(h.requests) : 0}</td><td class="n">${h ? (h.errorRate > 0.02 ? chip(`${icon('alert')}${(h.errorRate * 100).toFixed(1)}%`, 'warn') : `${(h.errorRate * 100).toFixed(1)}%`) : '—'}</td><td class="n">${h?.p50 ? `${fmt(h.p50)} ms` : '—'}</td><td>${c.active ? chip('启用', 'ok') : chip('停用')}</td><td class="n"><button class="btn sm" data-act="pick" data-id="${esc(c.id)}">选择模型</button> <button class="btn sm" data-act="test" data-id="${esc(c.id)}">测试连接</button> <button class="btn sm" data-act="channel" data-id="${esc(c.id)}">编辑</button></td></tr>`;
          })
          .join('')}</tbody></table>` : empty('还没有渠道。先新增一个渠道，再添加模型。'), { flush: true })}`;
    return `${tabs}<div class="toolbar"><span class="muted">用户看到对外名称和倍率；成本价是上游价格（元），售价是扣的点数，单位都是每百万 token。</span><span class="grow"></span>${data.channels.length ? `<button class="btn" data-act="pick" data-id="${esc(data.channels[0].id)}">${icon('search')}从渠道选择</button>` : ''}<button class="btn primary" data-act="model" ${data.channels.length ? '' : 'disabled'}>${icon('plus')}新增模型</button></div>
      ${card('模型', data.models.length ? `<table><thead><tr><th>对外名称</th><th>上游模型 · 渠道</th><th class="n">成本价 ¥<br><span class="muted">输入 / 缓存 / 输出</span></th><th class="n">售价 点<br><span class="muted">输入 / 缓存 / 输出</span></th><th class="n">综合毛利率</th><th>开放给</th><th class="n">近 30 天</th><th>状态</th><th></th></tr></thead><tbody>${data.models
        .map((m) => `<tr><td><b>${esc(m.name)}</b> ${chip(esc(m.tier))} ${m.isDefault ? `<span class="muted" title="默认模型">${icon('star')}</span>` : ''}<div class="muted num">${esc(m.id)}</div></td><td><span class="num">${esc(m.upstream)}</span><div class="muted">${esc(channelName.get(m.channelId) ?? '')}${m.backupChannelId ? ` · 备用 ${esc(channelName.get(m.backupChannelId) ?? '')}` : ''}</div></td><td class="n">${m.costInput} / ${m.costCached} / ${m.costOutput}</td><td class="n">${fmt(m.priceInput)} / ${fmt(m.priceCached)} / ${fmt(m.priceOutput)}</td><td class="n">${m.margin === null ? chip(`${icon('alert')}未定价`, 'bad') : m.margin < MIN_MARGIN ? chip(`${icon('alert')}${m.margin}%`, 'bad') : `${m.margin}%`}</td><td>${m.plans.map((p) => PLAN_SHORT[p] ?? esc(p)).join('、') || '<span class="muted">暂不开放</span>'}</td><td class="n">${short(m.points30)} 点</td><td>${m.active ? chip('上架', 'ok') : chip('未上架')}</td><td class="n"><button class="btn sm" data-act="model" data-id="${esc(m.id)}">编辑</button></td></tr>`)
        .join('')}</tbody></table>` : empty('还没有模型。'), { flush: true, sub: '综合毛利率按典型用量结构算：未命中输入 40%、缓存命中 52%、输出 8%' })}`;
  },
  afterRender(ctx) {
    const id = ctx.route.query.edit;
    if (id && ctx.data.models.some((m) => m.id === id)) modelsPage.act.model({ dataset: { id } }, ctx);
  },
  act: {
    model(el, ctx) {
      const m = ctx.data.models.find((item) => item.id === el.dataset.id) ?? {
        id: '', name: '', tier: '标准', upstream: '', channelId: ctx.data.channels[0]?.id, backupChannelId: null,
        costInput: 0, costCached: 0, costOutput: 0, priceInput: 0, priceCached: 0, priceOutput: 0, plans: ['pro'], active: false, isDefault: false, sort: 0,
      };
      const channelOptions = (selected, none) =>
        (none ? `<option value="">无</option>` : '') + ctx.data.channels.map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
      const automatic = PRICE_KEYS.every((k) => !m[`price${k}`] || m[`price${k}`] === autoPrice(m[`cost${k}`]));
      const triple = (label, prefix, values) =>
        `<div class="form-row"><label>${label}</label><div class="form-3">${['Input', 'Cached', 'Output'].map((k, i) => `<input class="text num" name="${prefix}${k}" value="${values[i]}" data-live>`).join('')}</div></div>`;
      ctx.dialog(
        frame(
          m.id ? `编辑模型 · ${esc(m.name)}` : '新增模型',
          `<div class="form-3"><div class="form-row"><label>模型 ID（客户端用）</label><input class="text num" name="id" value="${esc(m.id)}" ${m.id ? 'readonly' : ''} placeholder="例如 deepseek-v3.2"></div><div class="form-row"><label>对外名称</label><input class="text" name="name" value="${esc(m.name)}"></div><div class="form-row"><label>档位</label><select class="text" name="tier">${['经济', '标准', '高级'].map((t) => `<option ${t === m.tier ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>
           <div class="form-3"><div class="form-row"><label>渠道</label><select class="text" name="channelId" data-live>${channelOptions(m.channelId)}</select></div><div class="form-row"><label>上游模型</label><input class="text num" name="upstream" value="${esc(m.upstream)}" list="upstream-models" autocomplete="off" placeholder="从列表选或直接输入" data-live><datalist id="upstream-models"></datalist><div class="hint" data-upstream-hint></div></div><div class="form-row"><label>备用渠道</label><select class="text" name="backupChannelId">${channelOptions(m.backupChannelId, true)}</select></div></div>
           <div class="muted" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;font-size:12px"><span>输入</span><span>缓存命中的输入</span><span>输出（含思考）</span></div>
           ${triple('成本价（元 / 百万 token）', 'cost', [m.costInput, m.costCached, m.costOutput])}
           <label class="check"><input type="checkbox" name="autoPrice" data-live ${automatic ? 'checked' : ''}> 按成本加 10% 自动定价</label>
           ${triple('售价（点 / 百万 token，1 点 = ¥0.01）', 'price', [m.priceInput, m.priceCached, m.priceOutput])}
           <div class="preview" data-preview></div>
           <div class="form-row"><label>开放给</label><div class="chips-select">${['free', 'pro', 'team'].map((p) => `<label class="check"><input type="checkbox" name="plan_${p}" ${m.plans.includes(p) ? 'checked' : ''}> ${PLAN_SHORT[p]}</label>`).join('')}</div></div>
           <div class="form-3"><label class="check"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}> 上架</label><label class="check"><input type="checkbox" name="isDefault" ${m.isDefault ? 'checked' : ''}> 默认模型（倍率以它为 1×）</label><div class="form-row"><label>排序</label><input class="text num" name="sort" value="${m.sort}"></div></div>
           <div class="hint muted">改价从下一次请求开始生效，已经发出的额度不变。填好成本价就能上架，售价按成本加 10% 算出。</div>`,
          '<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="save-model">保存</button>',
          true,
        ),
      );
      ctx.state.editingModel = m.id;
      modelsPage.live();
      void fillUpstream(m.channelId);
    },
    pick(el, ctx) {
      const channels = ctx.data.channels;
      ctx.state.pick = { channelId: el.dataset.id || channels[0]?.id, models: null, selected: new Set(), error: '' };
      ctx.dialog(
        frame(
          '从渠道选择模型',
          `<div class="form-2"><div class="form-row"><label>渠道</label><select class="text" name="pickChannel" data-live>${channels.map((c) => `<option value="${esc(c.id)}" ${c.id === ctx.state.pick.channelId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
           <div class="form-row"><label>搜索</label><input class="text" name="pickFilter" placeholder="模型名" autocomplete="off" data-live></div></div>
           <label class="check"><input type="checkbox" name="pickAll" data-live> 也显示向量、语音、图像等非对话模型</label>
           <div class="pick-list" data-pick-list><div class="empty">正在读取渠道的模型列表…</div></div>
           <div class="note">${icon('info')}<span>选中的模型加进来后是“未上架”、开放给专业版，名称就是上游的模型名。在模型列表里填好成本价（售价自动算出）、改好名称后再上架。</span></div>`,
          '<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="import" data-pick-count disabled>添加所选</button>',
          true,
        ),
      );
      void loadPick(ctx);
    },
    async import(_el, ctx) {
      const pick = ctx.state.pick;
      const chosen = (pick.models ?? []).filter((m) => pick.selected.has(m.id));
      if (!chosen.length) throw new Error('请先勾选模型。');
      const result = await post('/models/import', { channelId: pick.channelId, models: chosen.map((m) => ({ upstream: m.id, name: m.name })) });
      upstreamCache.delete(pick.channelId);
      ctx.close();
      toast(`已添加 ${result.models.length} 个模型（未上架），填好成本价后上架`);
      if (ctx.route.query.tab === 'channels') location.hash = '#/models';
      else await ctx.reload();
    },
  },
  live(target, type, ctx) {
    if (target?.name?.startsWith('pick') || target?.dataset?.pick !== undefined) return pickLive(target, type, ctx);
    if (target?.name === 'channelId' && type === 'change') void fillUpstream(target.value);
    if (target?.name === 'upstream' && type === 'change') autofillModel(target.value);
    syncPrices();
    showMargins();
  },
};

// ---------- Upstream models of a channel ----------
const upstreamCache = new Map();
function upstreamList(channelId, fresh = false) {
  if (fresh || !upstreamCache.has(channelId)) {
    const request = get(`/channels/${encodeURIComponent(channelId)}/models`).then((result) => result.models);
    request.catch(() => upstreamCache.delete(channelId));
    upstreamCache.set(channelId, request);
  }
  return upstreamCache.get(channelId);
}
const slug = (value) =>
  String(value).trim().toLowerCase().replace(/[^a-z0-9._:/-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 72);

/** Suggests the channel's chat models in the model dialog's "上游模型" field. */
async function fillUpstream(channelId) {
  const hint = document.querySelector('#layer [data-upstream-hint]');
  if (!hint || !channelId) return;
  hint.textContent = '正在读取渠道的模型列表…';
  try {
    const models = await upstreamList(channelId);
    const list = document.querySelector('#layer #upstream-models');
    if (!list || document.querySelector('#layer [name=channelId]')?.value !== channelId) return;
    const chat = models.filter((m) => m.chat);
    list.innerHTML = chat.map((m) => `<option value="${esc(m.id)}">${esc([m.name !== m.id ? m.name : '', m.added ? '已添加' : ''].filter(Boolean).join(' · '))}</option>`).join('');
    hint.textContent = `识别到 ${chat.length} 个对话模型，点输入框选择`;
  } catch (error) {
    hint.textContent = `没能读取模型列表（${error.message}），可以直接输入`;
  }
}

/** Picking an upstream model fills an empty ID and name from it. */
function autofillModel(upstream) {
  const id = document.querySelector('#layer [name=id]');
  const name = document.querySelector('#layer [name=name]');
  if (!upstream.trim()) return;
  if (id && !id.readOnly && !id.value.trim()) id.value = slug(upstream);
  if (name && !name.value.trim()) {
    const channelId = document.querySelector('#layer [name=channelId]')?.value;
    void upstreamList(channelId)
      .then((models) => {
        if (!name.value.trim()) name.value = models.find((m) => m.id === upstream)?.name ?? upstream;
      })
      .catch(() => {
        if (!name.value.trim()) name.value = upstream;
      });
  }
}

async function loadPick(ctx, fresh = true) {
  const pick = ctx.state.pick;
  const channelId = pick.channelId;
  pick.models = null;
  pick.error = '';
  renderPick(ctx);
  try {
    const models = await upstreamList(channelId, fresh);
    if (ctx.state.pick !== pick || pick.channelId !== channelId) return;
    pick.models = models;
  } catch (error) {
    pick.error = error.message;
  }
  renderPick(ctx);
}

function renderPick(ctx) {
  const pick = ctx.state.pick;
  const box = document.querySelector('#layer [data-pick-list]');
  const button = document.querySelector('#layer [data-pick-count]');
  if (!box || !pick) return;
  if (button) {
    button.disabled = !pick.selected.size;
    button.textContent = pick.selected.size ? `添加所选（${pick.selected.size}）` : '添加所选';
  }
  if (pick.error) return void (box.innerHTML = `<div class="empty">没能读取模型列表：${esc(pick.error)}。可以在“新增模型”里直接输入上游模型名。</div>`);
  if (!pick.models) return void (box.innerHTML = '<div class="empty">正在读取渠道的模型列表…</div>');
  const filter = (document.querySelector('#layer [name=pickFilter]')?.value ?? '').trim().toLowerCase();
  const all = document.querySelector('#layer [name=pickAll]')?.checked;
  const shown = pick.models.filter((m) => (all || m.chat) && (!filter || m.id.toLowerCase().includes(filter) || m.name.toLowerCase().includes(filter)));
  const hidden = pick.models.filter((m) => !m.chat).length;
  box.innerHTML = shown.length
    ? shown
        .map(
          (m) => `<label class="pick-row ${m.added ? 'added' : ''}"><input type="checkbox" data-pick="${esc(m.id)}" data-live ${m.added ? 'checked disabled' : pick.selected.has(m.id) ? 'checked' : ''}><span class="num">${esc(m.id)}</span>${m.name !== m.id ? `<span class="muted">${esc(m.name)}</span>` : ''}${m.chat ? '' : chip('非对话')}${m.added ? `<span class="grow"></span>${chip(`已添加为 ${esc(m.added)}`)}` : ''}</label>`,
        )
        .join('')
    : `<div class="empty">${pick.models.length ? '没有符合条件的模型。' : '这个渠道没有返回任何模型。'}</div>`;
  if (!all && hidden) box.insertAdjacentHTML('beforeend', `<div class="muted" style="padding:8px 10px;font-size:12px">另有 ${hidden} 个非对话模型没有列出</div>`);
}

function pickLive(target, type, ctx) {
  const pick = ctx.state.pick;
  if (!pick) return;
  if (target.dataset.pick !== undefined) {
    if (type !== 'change') return;
    if (target.checked) pick.selected.add(target.dataset.pick);
    else pick.selected.delete(target.dataset.pick);
    const button = document.querySelector('#layer [data-pick-count]');
    button.disabled = !pick.selected.size;
    button.textContent = pick.selected.size ? `添加所选（${pick.selected.size}）` : '添加所选';
    return;
  }
  if (target.name === 'pickChannel') {
    if (type !== 'change') return;
    pick.channelId = target.value;
    pick.selected.clear();
    return void loadPick(ctx);
  }
  renderPick(ctx);
}

Object.assign(modelsPage.act, {
    async 'save-model'(_el, ctx) {
      const f = fields();
      const number = (v) => Number(v);
      const body = {
        id: f.id.trim(),
        name: f.name,
        tier: f.tier,
        upstream: f.upstream.trim(),
        channelId: f.channelId,
        backupChannelId: f.backupChannelId || '',
        costInput: number(f.costInput),
        costCached: number(f.costCached),
        costOutput: number(f.costOutput),
        priceInput: number(f.priceInput),
        priceCached: number(f.priceCached),
        priceOutput: number(f.priceOutput),
        autoPrice: !!f.autoPrice,
        plans: ['free', 'pro', 'team'].filter((p) => f[`plan_${p}`]),
        active: f.active,
        isDefault: f.isDefault,
        sort: number(f.sort) || 0,
      };
      if (Object.values(body).some((v) => typeof v === 'number' && !Number.isFinite(v))) throw new Error('价格要是数字。');
      if (ctx.state.editingModel) await put(`/models/${encodeURIComponent(ctx.state.editingModel)}`, body);
      else await post('/models', body);
      ctx.close();
      toast('已保存，下一次请求开始生效');
      await ctx.reload();
    },
    channel(el, ctx) {
      const c = ctx.data.channels.find((item) => item.id === el.dataset.id);
      ctx.dialog(
        frame(
          c ? `编辑渠道 · ${esc(c.name)}` : '新增渠道',
          `<input type="hidden" name="id" value="${esc(c?.id ?? '')}">
           <div class="form-row"><label>名称</label><input class="text" name="name" value="${esc(c?.name ?? '')}" placeholder="例如：阿里云百炼"></div>
           <div class="form-row"><label>Responses 地址</label><input class="text num" name="endpoint" value="${esc(c?.endpoint ?? '')}" placeholder="https://…/v1"></div>
           <div class="form-row"><label>Chat Completions 地址（和上面不同时填写）</label><input class="text num" name="chatEndpoint" value="${esc(c?.chatEndpoint ?? '')}"></div>
           <div class="form-row"><label>密钥</label><input class="text" type="password" name="key" autocomplete="off" placeholder="${c ? `不修改请留空（现在是 ····${esc(c.keyHint)}）` : '保存后只显示末四位'}"></div>
           <label class="check"><input type="checkbox" name="active" ${c?.active === false ? '' : 'checked'}> 启用</label>`,
          '<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="save-channel">保存</button>',
        ),
      );
    },
    async 'save-channel'(_el, ctx) {
      const f = fields();
      const body = { name: f.name, endpoint: f.endpoint.trim(), chatEndpoint: f.chatEndpoint.trim(), active: f.active, ...(f.key ? { key: f.key } : {}) };
      if (f.id) await put(`/channels/${encodeURIComponent(f.id)}`, body);
      else await post('/channels', body);
      ctx.close();
      toast('已保存渠道');
      await ctx.reload();
    },
    async test(el) {
      toast('正在测试…');
      const result = await post(`/channels/${encodeURIComponent(el.dataset.id)}/test`);
      if (result.ok) toast(`连接正常，${result.latencyMs} ms${result.models === null ? '' : `，可用模型 ${result.models} 个`}`);
      else toast(`连接失败：${result.status ? `HTTP ${result.status}` : result.error}`, true);
    },
});

/** With automatic pricing, the prices follow the costs as they are typed. */
function syncPrices() {
  const automatic = document.querySelector('#layer [name=autoPrice]');
  if (!automatic) return;
  for (const key of PRICE_KEYS) {
    const price = document.querySelector(`#layer [name=price${key}]`);
    const cost = document.querySelector(`#layer [name=cost${key}]`);
    if (!price || !cost) continue;
    price.readOnly = automatic.checked;
    if (automatic.checked) price.value = String(autoPrice(cost.value));
  }
}

/** Margins and a typical turn's points for the prices in the model dialog. */
function showMargins() {
  const preview = document.querySelector('#layer [data-preview]');
  if (!preview) return;
  const f = fields();
  const m = {
    costInput: Number(f.costInput) || 0, costCached: Number(f.costCached) || 0, costOutput: Number(f.costOutput) || 0,
    priceInput: Number(f.priceInput) || 0, priceCached: Number(f.priceCached) || 0, priceOutput: Number(f.priceOutput) || 0,
  };
  const part = (cost, price) => (price ? `${Math.round((1 - cost / (price / 100)) * 100)}%` : '—');
  const { margin } = typical(m);
  preview.innerHTML = `分项毛利率：输入 <b>${part(m.costInput, m.priceInput)}</b> · 缓存 <b>${part(m.costCached, m.priceCached)}</b> · 输出 <b>${part(m.costOutput, m.priceOutput)}</b><br>按典型用量结构，综合毛利率约 <b style="color:${margin !== null && margin < MIN_MARGIN ? 'var(--bad)' : 'inherit'}">${margin === null ? '—' : `${margin}%`}</b>${margin !== null && margin < MIN_MARGIN ? `，低于 ${MIN_MARGIN}%` : ''}；一轮读论文的对话约 ${fmt(Math.ceil((60000 * m.priceInput + 40000 * m.priceCached + 3000 * m.priceOutput) / 1e6))} 点`;
}

// ---------- Usage ----------
export const usagePage = {
  title: () => '用量',
  async load(route) {
    const days = route.query.days ?? 30;
    const group = route.query.group ?? 'user';
    const [report, catalog] = await Promise.all([get(`/usage?days=${days}&group=${group}`), get('/models')]);
    return { ...report, models: catalog.models };
  },
  view(data, route) {
    const series = seriesFor(data.models);
    const t = data.total;
    const head = '<th class="n">请求</th><th class="n">输入</th><th class="n">缓存命中</th><th class="n">输出</th><th class="n">点数</th><th class="n">上游成本</th><th class="n">估算</th><th class="n">失败</th>';
    const cells = (r) => `<td class="n">${fmt(r.requests)}</td><td class="n">${short(r.input)}</td><td class="n">${short(r.cached)}</td><td class="n">${short(r.output)}</td><td class="n">${fmt(r.points)}</td><td class="n">${money(r.cost)}</td><td class="n">${r.requests ? `${((r.estimated / r.requests) * 100).toFixed(1)}%` : '—'}</td><td class="n">${fmt(r.errors)}</td>`;
    const first = { user: '用户', team: '团队', model: '模型', plan: '套餐' }[data.group];
    const link = (r) => (data.group === 'user' ? `data-go="#/users/${encodeURIComponent(r.id)}" class="click"` : data.group === 'team' ? `data-go="#/teams/${encodeURIComponent(r.id)}" class="click"` : '');
    const table = data.rows.length
      ? `<table><thead><tr><th>${first}</th>${head}</tr></thead><tbody>${data.rows.map((r) => `<tr ${link(r)}><td><b>${esc(r.name)}</b>${r.phone ? ` <span class="muted num">${esc(r.phone)}</span>` : ''}${r.members ? ` <span class="muted">${r.members} 人</span>` : ''}${r.users ? ` <span class="muted">${r.users} 人</span>` : ''}</td>${cells(r)}</tr>`).join('')}</tbody></table>`
      : empty('这段时间没有使用记录。');
    const saleYuan = t.points / 100;
    return `
      <div class="toolbar">${seg('days', route.query.days ?? 30, [[7, '近 7 天'], [30, '近 30 天'], [90, '近 90 天']])}<span class="grow"></span><button class="btn" data-act="export">${icon('download')}导出 CSV</button></div>
      <div class="tiles" style="grid-template-columns:repeat(5,1fr)">
        ${tile('请求', fmt(t.requests), `失败 ${fmt(t.errors)}`)}
        ${tile('token', short(t.input + t.output), t.input ? `缓存命中 ${Math.round((t.cached / t.input) * 100)}%` : '')}
        ${tile('扣除点数', short(t.points), `按售价 ${money(saleYuan)}`)}
        ${tile('上游成本', money(t.cost), saleYuan ? `毛利 ${Math.round((1 - t.cost / saleYuan) * 100)}%` : '')}
        ${tile('估算的请求', t.requests ? `${((t.estimated / t.requests) * 100).toFixed(1)}%` : '—', '上游没报告用量时按字数估算')}
      </div>
      ${card('每日消耗', series.length ? legend(series) + chart(stackChart({ labels: data.days.map(md), rows: rowsFor(series, data.modelDaily), series })) : empty('还没有官方模型。'), { sub: '点' })}
      ${card('明细', table, { flush: true, actions: seg('group', data.group, [['user', '按用户'], ['team', '按团队'], ['model', '按模型'], ['plan', '按套餐']]) })}`;
  },
  act: {
    export(_el, ctx) {
      const d = ctx.data;
      const lines = ['名称,请求,输入,缓存命中,输出,点数,上游成本（元）,估算请求,失败'];
      for (const r of d.rows) lines.push([r.name, r.requests, r.input, r.cached, r.output, r.points, r.cost.toFixed(4), r.estimated, r.errors].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(','));
      download(`用量-${d.group}-${d.days[0]}-${d.days.at(-1)}.csv`, lines.join('\n'));
    },
  },
};

// ---------- Orders ----------
export const ordersPage = {
  title: () => '订单',
  load: () => get('/orders'),
  view(data) {
    return `
      <div class="toolbar"><span class="badge-phase">第一期：手动开通和兑换码；第二期：微信支付、支付宝、退款和发票</span><span class="grow"></span><button class="btn primary" data-act="open">${icon('plus')}手动开通</button></div>
      ${card('订单', data.orders.length ? `<table><thead><tr><th>订单号</th><th>用户</th><th>商品</th><th class="n">金额</th><th>方式</th><th>备注</th><th>时间</th><th>操作人</th></tr></thead><tbody>${data.orders
        .map((o) => `<tr class="click" data-go="#/users/${encodeURIComponent(o.userId)}"><td class="num">${esc(o.id)}</td><td class="who"><b>${esc(o.user)}</b><span class="muted num">${esc(o.phone)}</span></td><td>${esc(o.item)}</td><td class="n">${o.amount ? money(o.amount) : '—'}</td><td>${esc(o.method)}</td><td class="muted wrap">${esc(o.note) || '—'}</td><td class="num muted">${time(o.createdAt)}</td><td class="muted">${esc(o.admin) || '—'}</td></tr>`)
        .join('')}</tbody></table>` : empty('还没有订单。'), { flush: true })}`;
  },
  act: {
    open(_el, ctx) {
      ctx.dialog(planDialog('', ctx.state.plans, true));
    },
    async lookup() {
      const f = fields();
      const found = document.querySelector('#layer [data-found]');
      try {
        const user = await get(`/lookup?phone=${encodeURIComponent(f.phone.trim())}`);
        document.querySelector('#layer [name="userId"]').value = user.id;
        found.textContent = `找到：${user.name}（${user.phone}）`;
      } catch (error) {
        document.querySelector('#layer [name="userId"]').value = '';
        found.textContent = error.message;
      }
    },
    async 'do-plan'(_el, ctx) {
      await submitPlan(null);
      ctx.close();
      toast('已开通，已生成订单并记入审计');
      await ctx.reload();
    },
  },
};

// ---------- Audit ----------
export const auditPage = {
  title: () => '审计',
  load: () => get('/audit'),
  view(data) {
    return `<div class="toolbar"><span class="muted">后台的每一次写操作、登录和“显示手机号”都记在这里，不能删除。显示最近 200 条。</span></div>${card('审计', data.entries.length ? auditTable(data.entries) : empty('还没有记录。'), { flush: true })}`;
  },
};
