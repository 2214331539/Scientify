(() => {
  const profiles = {
    precision: {
      label: 'A · 利落',
      reason: '短距离，快收敛；偏向 IDE 的高频操作。',
      feedback: 100,
      selection: 150,
      page: 180,
      panel: 200,
      overlay: 160,
      exit: 100,
      distance: 4,
      panelDistance: 12,
      pressScale: 0.94,
      pressY: 1,
      ease: 'cubic-bezier(.2,.8,.2,1)',
    },
    balanced: {
      label: 'B · 平衡',
      reason: '清晰的按压、滑动与减速；适合阅读和开发混合工作。',
      feedback: 140,
      selection: 220,
      page: 260,
      panel: 280,
      overlay: 220,
      exit: 140,
      distance: 8,
      panelDistance: 24,
      pressScale: 0.88,
      pressY: 1.5,
      ease: 'cubic-bezier(.16,1,.3,1)',
    },
    expressive: {
      label: 'C · 层次',
      reason: '更明显的位移和回弹；适合偏好可见动效的用户。',
      feedback: 160,
      selection: 300,
      page: 340,
      panel: 360,
      overlay: 280,
      exit: 180,
      distance: 14,
      panelDistance: 40,
      pressScale: 0.8,
      pressY: 2,
      ease: 'cubic-bezier(.2,1.12,.3,1)',
    },
    continuous: {
      label: 'D · 柔和',
      reason: '借鉴 Apple 的柔和切换：旧画面逐隐，新画面逐显，位置保持稳定。',
      feedback: 140,
      selection: 220,
      page: 320,
      panel: 240,
      overlay: 220,
      exit: 180,
      distance: 0,
      panelDistance: 0,
      pressScale: 0.97,
      pressY: 0,
      ease: 'cubic-bezier(.42,0,.58,1)',
      continuous: true,
    },
  };
  const root = document.documentElement;
  let profileId = root.dataset.profile in profiles ? root.dataset.profile : 'continuous';
  let speed = 1;
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = media.matches;
  const icons = window.scientifyIcons;
  const icon = (name) => `<span class="icon">${icons[name] || ''}</span>`;
  const tool = (name, title, action, extra = '') =>
    `<button class="tool" type="button" aria-label="${title}" data-tip="${title}" data-action="${action}" ${extra}>${icon(name)}</button>`;
  const navItems = [
    ['literature', 'BookOpen', '文献'],
    ['code', 'Code2', '代码'],
    ['notes', 'NotebookPen', '笔记'],
    ['paper', 'PenLine', '论文'],
    ['collaboration', 'UsersRound', '团队协作'],
  ];
  const paperTitles = [
    'Parameter-Efficient Learning',
    'Reproducing the Baseline',
    'Evaluation Protocol',
  ];
  const code = [
    '<span class="kw">from</span> pathlib <span class="kw">import</span> Path',
    '<span class="kw">import</span> json',
    '<span class="kw">import</span> numpy <span class="kw">as</span> np',
    '',
    '<span class="comment"># Reproducible baseline experiment</span>',
    'SEED = <span class="num">42</span>',
    'OUTPUT = Path(<span class="str">"results/baseline"</span>)',
    '',
    '<span class="kw">def</span> run_experiment(seed: <span class="kw">int</span>) -> <span class="kw">dict</span>:',
    '    rng = np.random.default_rng(seed)',
    '    samples = rng.normal(size=(<span class="num">1000</span>, <span class="num">32</span>))',
    '    scores = evaluate(samples)',
    '    <span class="kw">return</span> {<span class="str">"seed"</span>: seed, <span class="str">"accuracy"</span>: scores.mean()}',
    '',
    '<span class="kw">if</span> __name__ == <span class="str">"__main__"</span>:',
    '    OUTPUT.mkdir(parents=<span class="kw">True</span>, exist_ok=<span class="kw">True</span>)',
    '    result = run_experiment(SEED)',
    '    (OUTPUT / <span class="str">"metrics.json"</span>).write_text(',
    '        json.dumps(result, indent=<span class="num">2</span>)',
    '    )',
    '    print(result)',
  ]
    .map((line, n) => `<span class="ln">${n + 1}</span>${line}`)
    .join('\n');
  document.getElementById('motion-lab').innerHTML = `
    <header class="lab-bar">
      <div class="brand"><img src="../../营销思路/Scientify-Logo-Kit/web/icon-192.png" alt="" /><div><strong>Scientify</strong><small>动效方案比较 · 本地交互样例</small></div></div>
      <div class="profiles" role="group" aria-label="动效方案">${Object.entries(profiles)
        .map(
          ([id, p]) =>
            `<button data-profile-choice="${id}" aria-pressed="false">${p.label}</button>`,
        )
        .join('')}</div>
      <div class="lab-controls"><label>回放速度<select aria-label="回放速度"><option value="1">1×</option><option value=".5">0.5×</option><option value=".25">0.25×</option></select></label><label><input type="checkbox" id="reduced-motion" />减少动态</label>${tool('RotateCcw', '回放切页', 'replay')}${tool('Moon', '切换为深色', 'theme')}</div>
    </header>
    <div class="lab-summary"><strong id="profile-name"></strong><span class="profile-reason" id="profile-reason"></span><span class="spacer"></span><span class="muted">虚构材料 · 模拟 AI / 运行</span></div>
    <section class="workspace" aria-label="Scientify 交互样例">
      <header class="app-topbar"><span class="app-brand">Scientify</span><span class="topbar-separator"></span><span class="project-title">Baseline reproduction ${icon('ChevronDown')}</span><span class="spacer"></span><button class="command" data-action="settings">${icon('Settings2')}<span>项目设置</span></button></header>
      <div class="workspace-stage">
        <nav class="rail" aria-label="工作区导航"><span class="rail-indicator" aria-hidden="true"></span>${navItems.map(([id, name, title]) => tool(name, title, `nav:${id}`, `data-nav="${id}"`)).join('')}<span class="spacer"></span>${tool('Bot', 'AI 助手', 'assistant', 'aria-pressed="false"')}</nav>
        <aside class="resource" aria-label="资源侧栏"><header class="resource-header"><span id="resource-title">文献库</span><span class="spacer"></span>${tool('Plus', '新建材料', 'create')}</header><label class="resource-search">${icon('Search')}<input aria-label="搜索材料" placeholder="搜索材料…" /></label><div class="tree-group"><button class="tree-heading" data-action="tree" aria-expanded="true">${icon('ChevronRight')}<strong>Baseline reproduction</strong></button><div id="tree-children">
          <div data-resource="literature">${paperTitles.map((title, i) => `<button class="row" data-action="paper:${i}" aria-pressed="${i === 0}">${icon('FileText')}<span>${title}.pdf</span></button>`).join('')}</div>
          <div data-resource="code" hidden>${['train.py', 'evaluate.py', 'requirements.txt', 'README.md'].map((title, i) => `<button class="row" data-action="file:${i}" aria-pressed="${i === 0}">${icon('FileText')}<span>${title}</span></button>`).join('')}</div>
          <div data-resource="notes" hidden><button class="row" data-action="note" aria-pressed="true">${icon('NotebookPen')}<span>复现实验记录.md</span></button></div>
        </div></div><div class="resource-foot">${icon('Folder')}<span>本地项目</span></div></aside>
        <main class="main-area"><div class="document-tabs view-chrome"><div class="document-tab">${icon('FileText')}<span id="tab-title">Parameter-Efficient Learning.pdf</span></div><span class="spacer"></span>${tool('MoreHorizontal', '文件操作', 'menu')}</div><header class="page-title view-chrome"><h1 id="page-name">文献阅读</h1><span class="muted" id="page-meta">第 1 页 / 共 12 页</span><span class="spacer"></span><button class="command" data-action="save">${icon('Save')}<span>保存</span></button><button class="command" data-action="run" id="run-button" hidden>${icon('Play')}<span>运行</span></button></header><div class="page-stack">
          <article class="view-pane paper-canvas" data-page="literature"><div class="paper-sheet"><div class="paper-journal">Research notes · October 2026</div><h2 id="paper-title">Parameter-Efficient Learning for Reproducible Research</h2><div class="authors">A. Chen, M. Zhang · Working paper</div><h3>Abstract</h3><p>We investigate a lightweight adaptation strategy for evaluating scientific baselines. Our protocol separates the training configuration, execution environment, and evaluation results.</p><p><mark>Reproduction requires consistent data splits and controlled random seeds across experiments.</mark> We report both average performance and variability across repeated runs.</p><h3>1. Experimental protocol</h3><p>Each experiment uses an independent environment and records the exact command, dependency versions, and source revision. This makes differences between runs easier to inspect.</p><div class="equation">L(θ) = ⅟ₙ ∑ᵢ ℓ(fθ(xᵢ), yᵢ) + λ ‖θ‖²</div><div class="note-callout">研究笔记 · 对照组统一使用 seed = 42，先复现 baseline，再逐项做消融实验。</div><h3>2. Evaluation</h3><p>We compare the baseline against each ablation under the same evaluation protocol. Metrics and raw predictions are stored alongside the corresponding run.</p></div></article>
          <section class="view-pane code-pane" data-page="code" hidden><div class="code-header">experiments ${icon('ChevronRight')} baseline ${icon('ChevronRight')} <span id="code-file-name">train.py</span></div><pre class="code-lines"><code>${code}</code></pre><section class="terminal-panel" aria-label="模拟终端"><header class="terminal-header"><span class="active">终端</span><span class="muted">输出</span><span class="muted">问题</span><span class="spacer"></span><span class="muted">Python 3.12 · .venv</span></header><pre class="terminal-output" id="terminal-output"><span class="success">(.venv)</span> PS baseline&gt; python train.py\nLoading configuration…\nSeed: 42   Samples: 1000\n<span class="success">Accuracy: 0.9234</span>\nSaved results/baseline/metrics.json\n<span class="success">(.venv)</span> PS baseline&gt; ▍</pre></section></section>
          <section class="view-pane notes-pane" data-page="notes" hidden><div class="note-title">${icon('NotebookPen')}<h2>复现实验记录</h2></div><textarea class="note-editor" aria-label="笔记正文" spellcheck="false"># 复现实验记录\n\n## Baseline\n固定随机种子为 42，使用独立的 Python 环境。\n\n## 下一步\n- 检查训练集与验证集划分\n- 记录每次运行的 Git commit\n- 增加三个随机种子的对照实验\n\n## 阅读发现\n论文采用相同的评估协议进行消融实验。</textarea><div class="notes-meta">${icon('Check')}<span id="note-status">已保存到本地</span></div></section>
          <section class="view-pane placeholder" data-page="paper" hidden>${icon('PenLine')}<h2>LaTeX 论文撰写</h2><p>开发中 · 敬请期待</p></section><section class="view-pane placeholder" data-page="collaboration" hidden>${icon('UsersRound')}<h2>团队协作空间</h2><p>开发中 · 敬请期待</p></section>
        </div></main>
        <aside class="assistant" aria-label="AI 助手" hidden><header class="assistant-header">${icon('Bot')}<strong>复现 baseline</strong><span class="spacer"></span>${tool('Plus', '新建会话', 'new-chat')}${tool('PanelRightClose', '收起 AI 助手', 'assistant-close')}</header><div class="messages" aria-live="polite"><div class="message user">帮我检查 baseline 的实验配置。</div><div class="execution"><button data-action="execution" aria-expanded="false">${icon('ChevronRight')}<span>已读取 train.py 和 requirements.txt</span></button><pre id="execution-detail" hidden>read: experiments/baseline/train.py\nread: experiments/baseline/requirements.txt</pre></div><div class="message assistant-text"><p>配置已检查。当前使用独立的 <code>.venv</code> 环境，随机种子为 <code>42</code>。</p><p>建议再增加三个随机种子的对照运行，并将原始预测与 <code>metrics.json</code> 一同保存。</p></div></div><div class="composer"><textarea aria-label="向 AI 提问" placeholder="继续讨论这个实验…" rows="2"></textarea><div class="composer-tools">${tool('Paperclip', '添加材料', 'material')}<button class="model-button" data-action="models">deepseek-flash ${icon('ChevronDown')}</button><span class="spacer"></span><span class="spinner" id="ai-spinner" hidden></span>${tool('ArrowUp', '发送', 'send')}</div></div></aside>
      </div><footer class="statusbar"><span class="status-dot"></span><span id="save-status">已保存</span><span class="spacer"></span><span>本地工作区</span>${tool('Bot', 'AI 助手', 'assistant', 'aria-pressed="false"')}${tool('NotebookPen', '研究笔记', 'nav:notes')}</footer>
    </section>
    <footer class="metrics"><dl><dt>按压反馈</dt><dd id="metric-feedback"></dd></dl><dl><dt>切页</dt><dd id="metric-page"></dd></dl><dl><dt>辅助栏</dt><dd id="metric-panel"></dd></dl><dl><dt>菜单 / 弹窗</dt><dd id="metric-overlay"></dd></dl><dl><dt>切页位移</dt><dd id="metric-distance"></dd></dl><div class="review-choice"><small>切换工作区、展开 AI、点文件菜单或项目设置</small><button class="command primary" data-action="choose">${icon('Check')}选这套方案</button><output class="review-output" id="review-output" aria-live="polite"></output></div></footer>
    <div class="popover" role="menu" aria-label="文件操作" hidden><button role="menuitem" data-action="copy">${icon('Copy')}复制文件名</button><button role="menuitem" data-action="save">${icon('Save')}保存</button><div class="popover-separator"></div><button role="menuitem" data-action="settings">${icon('Settings2')}项目设置</button></div>
    <dialog aria-labelledby="settings-title"><form method="dialog"><header class="dialog-header"><h2 id="settings-title">项目设置</h2><span class="spacer"></span>${tool('X', '关闭弹窗', 'dialog-close')}</header><div class="dialog-body"><label>项目名称<input value="Baseline reproduction" name="project-name" required /></label><label>研究问题<input value="复现 baseline 并评估消融实验" name="research-question" /></label></div><footer class="dialog-footer"><button class="command" type="button" data-action="dialog-close">取消</button><button class="command primary" type="submit">${icon('Check')}保存</button></footer></form></dialog>
    <div class="toast" role="status" hidden>${icon('Check')}<span></span></div>`;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  // Every scenario resolves the same profile; event handlers never invent durations.
  const activeAnimations = new WeakMap();
  const runningAnimations = new Set();
  let currentPage = 'literature';
  let previousPage = 'code';
  let navigationRevision = 0;
  function settlePages() {
    ++navigationRevision;
    $$('[data-page]').forEach((pane) => {
      activeAnimations.get(pane)?.cancel();
      const active = pane.dataset.page === currentPage;
      pane.hidden = !active;
      pane.inert = !active;
      if (active) pane.removeAttribute('aria-hidden');
      else pane.setAttribute('aria-hidden', 'true');
      pane.style.removeProperty('z-index');
    });
    $('.page-stack').removeAttribute('data-transitioning');
  }
  function cancelAnimations() {
    for (const animation of runningAnimations) animation.cancel();
    runningAnimations.clear();
  }
  function playMotion(element, scene, frames, exiting = false) {
    activeAnimations.get(element)?.cancel();
    element.dataset.motionScene = scene;
    if (reduced || media.matches || !element.animate) {
      element.dataset.motionState = 'instant';
      element.dataset.motionDuration = '0';
      return Promise.resolve();
    }
    const p = profiles[profileId];
    const duration = (exiting ? p.exit : p[scene]) / speed;
    const animation = element.animate(frames, {
      duration,
      easing: p.ease,
      fill: p.continuous && scene === 'page' ? 'both' : 'none',
    });
    activeAnimations.set(element, animation);
    runningAnimations.add(animation);
    element.dataset.motionState = 'running';
    element.dataset.motionDuration = String(duration);
    const started = performance.now();
    return animation.finished
      .then(() => {
        if (activeAnimations.get(element) === animation) {
          element.dataset.motionState = 'finished';
          element.dataset.motionElapsed = String(Math.round(performance.now() - started));
        }
      })
      .catch(() => {
        if (activeAnimations.get(element) === animation) element.dataset.motionState = 'cancelled';
      })
      .finally(() => runningAnimations.delete(animation));
  }
  function animate(element, scene, exiting = false) {
    const p = profiles[profileId];
    const offset =
      scene === 'panel' ? `translateX(${p.panelDistance}px)` : `translateY(${p.distance}px)`;
    const base = element.matches('.toast') ? 'translateX(-50%)' : '';
    const frames = p.continuous
      ? [
          { opacity: element.matches('.view-chrome') ? 1 : 0, transform: base || 'none' },
          { opacity: 1, transform: base || 'none' },
        ]
      : [
          { opacity: scene === 'page' ? 0.3 : 0, transform: `${base} ${offset}`.trim() },
          { opacity: 1, transform: base || 'none' },
        ];
    if (exiting) frames.reverse();
    if (p.continuous && activeAnimations.get(element)?.playState === 'running') {
      const painted = getComputedStyle(element);
      frames[0] = { opacity: Number(painted.opacity), transform: painted.transform };
    }
    return playMotion(element, scene, frames, exiting);
  }
  function fadePages(next) {
    const panes = $$('[data-page]');
    const incoming = $(`[data-page="${next}"]`);
    if (reduced || media.matches || !incoming.animate) {
      panes.forEach((pane) => activeAnimations.get(pane)?.cancel());
      incoming.dataset.motionState = 'instant';
      incoming.dataset.motionDuration = '0';
      settlePages();
      return;
    }
    // Preserve the painted composite and layer order when a fade is interrupted.
    const starts = new Map(
      panes
        .filter((pane) => !pane.hidden)
        .map((pane) => [
          pane,
          { opacity: Number(getComputedStyle(pane).opacity), zIndex: Number(pane.style.zIndex) },
        ]),
    );
    const incomingLayer =
      starts.get(incoming)?.zIndex ??
      Math.max(0, ...[...starts.values()].map((start) => start.zIndex)) + 1;
    const revision = ++navigationRevision;
    $('.page-stack').dataset.transitioning = 'true';
    const jobs = panes.flatMap((pane) => {
      if (pane !== incoming && pane.hidden) return [];
      const start = starts.get(pane) || { opacity: 0, zIndex: incomingLayer };
      pane.hidden = false;
      pane.inert = pane !== incoming;
      if (pane === incoming) pane.removeAttribute('aria-hidden');
      else pane.setAttribute('aria-hidden', 'true');
      pane.style.zIndex = String(start.zIndex);
      return [
        playMotion(pane, 'page', [
          { opacity: start.opacity, transform: 'none' },
          {
            opacity: pane === incoming ? 1 : start.zIndex > incomingLayer ? 0 : start.opacity,
            transform: 'none',
          },
        ]),
      ];
    });
    void Promise.all(jobs).then(() => {
      if (revision === navigationRevision) settlePages();
    });
  }
  function applyProfile(next) {
    cancelAnimations();
    settlePages();
    profileId = next;
    const p = profiles[next];
    root.dataset.profile = next;
    root.dataset.reduced = String(reduced || media.matches);
    for (const [key, value] of Object.entries(p)) {
      if (typeof value !== 'number') continue;
      const unit = ['distance', 'panelDistance', 'pressY'].includes(key)
        ? 'px'
        : key === 'pressScale'
          ? ''
          : 'ms';
      root.style.setProperty(
        `--${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`,
        `${unit === 'ms' ? value / speed : value}${unit}`,
      );
    }
    root.style.setProperty('--ease', p.ease);
    $$('[data-profile-choice]').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.profileChoice === next)),
    );
    $('#profile-name').textContent = p.label;
    $('#profile-reason').textContent = p.reason;
    for (const metric of ['feedback', 'page', 'panel', 'overlay'])
      $(`#metric-${metric}`).textContent = `${p[metric]} ms`;
    $('#metric-distance').textContent = p.continuous ? '0 px · 交叉淡化' : `${p.distance} px`;
    $('#reduced-motion').checked = reduced || media.matches;
    $('#review-output').textContent = '';
    $('.resource').hidden = !p.continuous && !['literature', 'code', 'notes'].includes(currentPage);
  }
  function navigate(next) {
    if (currentPage === next) return;
    previousPage = currentPage;
    currentPage = next;
    if (profiles[profileId].continuous) fadePages(next);
    else settlePages();
    $$('[data-resource]').forEach((list) => {
      list.hidden = list.dataset.resource !== next;
    });
    const position = navItems.findIndex(([id]) => id === next);
    $('.rail-indicator').style.transform = `translateY(${position * 46}px)`;
    $$('[data-nav]').forEach((button) =>
      next === button.dataset.nav
        ? button.setAttribute('aria-current', 'page')
        : button.removeAttribute('aria-current'),
    );
    const metadata = {
      literature: ['文献库', '文献阅读', '第 1 页 / 共 12 页', paperTitles[0] + '.pdf'],
      code: ['资源管理器', 'Baseline', 'main · Python 3.12', 'train.py'],
      notes: ['研究笔记', '笔记', '项目笔记', '复现实验记录.md'],
      paper: ['论文', 'LaTeX 论文撰写', '', '论文'],
      collaboration: ['团队', '团队协作空间', '', '团队协作'],
    }[next];
    $('#resource-title').textContent = metadata[0];
    $('#page-name').textContent = metadata[1];
    $('#page-meta').textContent = metadata[2];
    $('#tab-title').textContent = metadata[3];
    $('.resource').dataset.empty = String(!['literature', 'code', 'notes'].includes(next));
    $('.resource').hidden =
      !profiles[profileId].continuous && !['literature', 'code', 'notes'].includes(next);
    $('#run-button').hidden = next !== 'code';
    if (!profiles[profileId].continuous) {
      $$('.view-chrome').forEach((chrome) => void animate(chrome, 'page'));
      if (['paper', 'collaboration'].includes(next))
        void animate($(`[data-page="${next}"]`), 'page');
    }
  }
  let dockRevision = 0;
  async function setAssistant(open) {
    const drawer = $('.assistant');
    const revision = ++dockRevision;
    $$('[data-action="assistant"]').forEach((button) =>
      button.setAttribute('aria-pressed', String(open)),
    );
    if (open) {
      drawer.hidden = false;
      drawer.inert = false;
      drawer.removeAttribute('aria-hidden');
      await animate(drawer, 'panel');
    } else {
      drawer.inert = true;
      drawer.setAttribute('aria-hidden', 'true');
      await animate(drawer, 'panel', true);
      if (revision === dockRevision) {
        drawer.hidden = true;
        $('[data-action="assistant"]').focus();
      }
    }
  }
  let menuRevision = 0;
  async function closeMenu() {
    const menu = $('.popover');
    if (menu.hidden) return;
    const revision = ++menuRevision;
    menu.inert = true;
    menu.setAttribute('aria-hidden', 'true');
    $('[data-action="menu"]').setAttribute('aria-expanded', 'false');
    await animate(menu, 'overlay', true);
    if (menuRevision === revision) menu.hidden = true;
  }
  function openMenu(trigger) {
    ++menuRevision;
    const menu = $('.popover');
    const rect = trigger.getBoundingClientRect();
    menu.hidden = false;
    menu.inert = false;
    menu.removeAttribute('aria-hidden');
    menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.right - 190, window.innerWidth - 198))}px`;
    trigger.setAttribute('aria-expanded', 'true');
    void animate(menu, 'overlay');
    menu.querySelector('button').focus();
  }
  let dialogRevision = 0;
  function openDialog() {
    ++dialogRevision;
    const dialog = $('dialog');
    dialog.inert = false;
    dialog.removeAttribute('aria-hidden');
    dialog.showModal();
    void animate(dialog, 'overlay');
  }
  async function closeDialog() {
    const dialog = $('dialog');
    if (!dialog.open || dialog.inert) return;
    const revision = ++dialogRevision;
    dialog.inert = true;
    dialog.setAttribute('aria-hidden', 'true');
    await animate(dialog, 'overlay', true);
    if (revision === dialogRevision) {
      dialog.close();
      dialog.inert = false;
      dialog.removeAttribute('aria-hidden');
    }
  }
  $('dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    void closeDialog();
  });
  let toastTimer;
  function notify(text) {
    clearTimeout(toastTimer);
    $('.toast span:last-child').textContent = text;
    $('.toast').hidden = false;
    void animate($('.toast'), 'overlay');
    toastTimer = setTimeout(() => {
      $('.toast').hidden = true;
    }, 2400);
  }
  let streamTimer;
  let activeMessage = null;
  function stopStream() {
    clearTimeout(streamTimer);
    if (activeMessage) {
      const suffix = document.createElement('p');
      suffix.className = 'muted';
      suffix.textContent = '已中止';
      activeMessage.append(suffix);
    }
    activeMessage = null;
    $('#ai-spinner').hidden = true;
    const send = $('[data-action="send"]');
    send.innerHTML = icon('ArrowUp');
    send.setAttribute('aria-label', '发送');
    send.dataset.tip = '发送';
  }
  function sendMessage() {
    if (activeMessage) {
      stopStream();
      return;
    }
    const input = $('.composer textarea');
    const question = input.value.trim();
    if (!question) {
      input.focus();
      return;
    }
    const messages = $('.messages');
    const user = document.createElement('div');
    user.className = 'message user';
    user.textContent = question;
    messages.append(user);
    void animate(user, 'page');
    input.value = '';
    activeMessage = document.createElement('div');
    activeMessage.className = 'message assistant-text';
    messages.append(activeMessage);
    $('#ai-spinner').hidden = false;
    const send = $('[data-action="send"]');
    send.innerHTML = icon('Square');
    send.setAttribute('aria-label', '中止');
    send.dataset.tip = '中止';
    const answer =
      '可以。先固定数据划分、随机种子与依赖版本，再分别运行 baseline 和消融实验。\n\n每次运行保留日志、指标和对应的 Git commit，便于之后比较结果。';
    const target = activeMessage;
    target.style.whiteSpace = 'pre-wrap';
    let cursor = 0;
    const tick = () => {
      if (target !== activeMessage) return;
      cursor += 2;
      target.textContent = answer.slice(0, cursor);
      if (messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90)
        messages.scrollTop = messages.scrollHeight;
      if (cursor < answer.length) streamTimer = setTimeout(tick, 30);
      else {
        activeMessage = null;
        stopStream();
      }
    };
    messages.scrollTop = messages.scrollHeight;
    tick();
  }
  let runTimer;
  let running = false;
  function toggleRun() {
    const button = $('#run-button');
    clearTimeout(runTimer);
    if (running) {
      $('#terminal-output').textContent += '\nProcess interrupted.\n(.venv) PS baseline> ';
      running = false;
    } else {
      running = true;
      $('#terminal-output').textContent =
        '(.venv) PS baseline> python train.py\nLoading configuration…\nTraining baseline…';
      runTimer = setTimeout(() => {
        running = false;
        $('#terminal-output').textContent +=
          '\nAccuracy: 0.9234\nSaved results/baseline/metrics.json\n(.venv) PS baseline> ';
        button.innerHTML = icon('Play') + '<span>运行</span>';
        notify('模拟运行完成');
      }, 1800);
    }
    button.innerHTML =
      icon(running ? 'Square' : 'Play') + `<span>${running ? '停止' : '运行'}</span>`;
    void animate($('.terminal-header'), 'page');
  }
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.profileChoice) {
      applyProfile(button.dataset.profileChoice);
      $$('.view-chrome').forEach((chrome) => void animate(chrome, 'page'));
      return;
    }
    const action = button.dataset.action;
    if (!action) return;
    if (action !== 'menu') void closeMenu();
    if (action.startsWith('nav:')) {
      navigate(action.slice(4));
      return;
    }
    if (action.startsWith('paper:')) {
      const selected = Number(action.slice(6));
      $$('[data-action^="paper:"]').forEach((row) =>
        row.setAttribute('aria-pressed', String(row === button)),
      );
      $('#paper-title').textContent = paperTitles[selected];
      $('#tab-title').textContent = paperTitles[selected] + '.pdf';
      void animate($('.document-tabs'), 'page');
      return;
    }
    if (action.startsWith('file:')) {
      $$('[data-action^="file:"]').forEach((row) =>
        row.setAttribute('aria-pressed', String(row === button)),
      );
      $('#tab-title').textContent = button.textContent;
      $('#code-file-name').textContent = button.textContent;
      void animate($('.document-tabs'), 'page');
      return;
    }
    switch (action) {
      case 'theme': {
        const dark = root.dataset.theme !== 'dark';
        root.dataset.theme = dark ? 'dark' : 'light';
        button.innerHTML = icon(dark ? 'Sun' : 'Moon');
        const title = dark ? '切换为浅色' : '切换为深色';
        button.setAttribute('aria-label', title);
        button.dataset.tip = title;
        void animate(button, 'overlay');
        break;
      }
      case 'replay':
        if (profiles[profileId].continuous) navigate(previousPage);
        else $$('.view-chrome').forEach((chrome) => void animate(chrome, 'page'));
        break;
      case 'assistant':
        await setAssistant($('.assistant').hidden || $('.assistant').inert);
        break;
      case 'assistant-close':
        await setAssistant(false);
        break;
      case 'tree': {
        const expanded = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(expanded));
        $('#tree-children').hidden = !expanded;
        if (expanded) void animate($('#tree-children'), 'page');
        break;
      }
      case 'execution': {
        const expanded = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(expanded));
        $('#execution-detail').hidden = !expanded;
        if (expanded) void animate($('#execution-detail'), 'page');
        break;
      }
      case 'menu':
        if ($('.popover').hidden || $('.popover').inert) openMenu(button);
        else await closeMenu();
        break;
      case 'settings':
        openDialog();
        break;
      case 'dialog-close':
        void closeDialog();
        break;
      case 'save':
        $('#save-status').textContent = '已保存';
        $('#note-status').textContent = '已保存到本地';
        notify('样例已保存');
        break;
      case 'copy': {
        const name = $('#tab-title').textContent;
        try {
          await navigator.clipboard.writeText(name);
          notify('已复制文件名');
        } catch {
          notify(name);
        }
        break;
      }
      case 'run':
        toggleRun();
        break;
      case 'send':
        sendMessage();
        break;
      case 'new-chat':
        stopStream();
        $('.messages').replaceChildren();
        $('.composer textarea').focus();
        break;
      case 'choose':
        $('#review-output').textContent = `已选择 ${profiles[profileId].label}`;
        notify(`已选择 ${profiles[profileId].label}，请把方案名称发给我`);
        break;
      case 'models':
        notify('当前模型：deepseek-flash（模拟）');
        break;
      case 'material':
        notify('当前材料：' + $('#tab-title').textContent);
        break;
      case 'create':
        openDialog();
        break;
      case 'note':
        navigate('notes');
        break;
    }
  });
  function press(button) {
    const glyph = button?.querySelector('.icon');
    if (glyph?.animate && !button.disabled && !reduced && !media.matches) {
      activeAnimations.get(glyph)?.cancel();
      const p = profiles[profileId];
      const animation = glyph.animate(
        [
          { transform: 'scale(1)' },
          { transform: `scale(${p.pressScale})`, offset: 0.35 },
          { transform: 'scale(1)' },
        ],
        { duration: p.feedback / speed, easing: p.ease },
      );
      activeAnimations.set(glyph, animation);
      runningAnimations.add(animation);
      void animation.finished.catch(() => {}).finally(() => runningAnimations.delete(animation));
    }
  }
  document.addEventListener('pointerdown', (event) => {
    press(event.target.closest('button'));
    if (!event.target.closest('.popover, [data-action="menu"]')) void closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (['Enter', ' '].includes(event.key) && !event.repeat) press(event.target.closest('button'));
    if (event.key === 'Escape') {
      if ($('dialog').open) return;
      if (!$('.popover').hidden) {
        void closeMenu();
        $('[data-action="menu"]').focus();
        return;
      }
      if (!$('.assistant').hidden) void setAssistant(false);
    }
    if (!event.target.closest('.popover')) return;
    const items = $$('.popover button');
    const index = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      void closeMenu();
      $('[data-action="menu"]').focus();
    }
  });
  $('.composer textarea').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });
  $('.note-editor').addEventListener('input', () => {
    $('#note-status').textContent = '未保存';
    $('#save-status').textContent = '有未保存内容';
  });
  $('.resource-search input').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLocaleLowerCase();
    $$('.row').forEach((row) => {
      row.hidden = !row.textContent.toLocaleLowerCase().includes(query);
    });
  });
  $('dialog form').addEventListener('submit', (event) => {
    event.preventDefault();
    $('.project-title').firstChild.textContent = $('[name="project-name"]').value + ' ';
    notify('项目设置已保存（样例）');
    void closeDialog();
  });
  $('#reduced-motion').addEventListener('change', (event) => {
    reduced = event.target.checked;
    applyProfile(profileId);
  });
  $('[aria-label="回放速度"]').addEventListener('change', (event) => {
    speed = Number(event.target.value);
    applyProfile(profileId);
  });
  media.addEventListener('change', () => applyProfile(profileId));
  window.addEventListener('resize', () => void closeMenu());
  applyProfile(profileId);
  $('[data-nav="literature"]').setAttribute('aria-current', 'page');
  $('[data-action="menu"]').setAttribute('aria-haspopup', 'menu');
  $('[data-action="menu"]').setAttribute('aria-expanded', 'false');
  $('[data-action="send"]').classList.add('send');
})();
