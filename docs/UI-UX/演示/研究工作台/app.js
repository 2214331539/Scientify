// Standalone prototype: all content and actions stay in this page's memory.
const $ = s => document.querySelector(s);
const paths = {
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  book:'<path d="M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H3zM12 7a3 3 0 0 1 3-3h6v15h-5a4 4 0 0 0-4 2"/>',
  grid:'<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  note:'<path d="M19 11v9H4V4h10M9 15l3-1L21 5l-3-3-9 9z"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',
  cloud:'<path d="M7 18a5 5 0 1 1 1-10 6 6 0 0 1 11 2 4 4 0 0 1-1 8M9 14l3 3 5-5"/>',
  ai:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  panel:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
  users:'<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5"/>',
  inbox:'<path d="m5 4-3 12v4h20v-4L19 4zM2 16h6l2 3h4l2-3h6"/>',
  doc:'<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6"/>',
  send:'<path d="M12 20V4m-6 6 6-6 6 6"/>',
  list:'<path d="M8 6h12M8 12h12M8 18h12M3 6h1M3 12h1M3 18h1"/>'
};
const icon = name => '<svg aria-hidden="true" viewBox="0 0 24 24">'+paths[name]+'</svg>';
const esc = text => text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const logo = '<img src="../../../../public/brand/scientify-light.png" alt="">';
const projects = [
  {name:'主动智能体',en:'AGENCY & REASONING',subtitle:'Learning when to act',color:'sage',papers:24,notes:8,date:'今天 10:42 打开',favorite:true},
  {name:'长期记忆',en:'MEMORY & RETRIEVAL',subtitle:'From context to continuity',color:'clay',papers:16,notes:5,date:'昨天打开',favorite:true},
  {name:'多模态理解',en:'PERCEPTION & LEARNING',subtitle:'Seeing the bigger picture',color:'blue',papers:12,notes:3,date:'周一打开',favorite:false}
];
const papers = ['Learning when to act','Beyond reactive assistance','Continuous observation for proactive systems','Memory as a foundation for adaptive agents'];
let view='projects',panel='ai',panelOpen=true,stream=null,page=4,zoom=100;
let libraryManual=false,toastTimer,filter='all',reverse=false;
$('#theme-toggle').innerHTML=icon('sun');
$('#projects-view').innerHTML=`
  <aside class="sidebar"><a href="#projects" class="brand" data-view="projects">${logo}<strong>Scientify</strong></a>
  <button class="search-launch" data-search>${icon('search')}<span>搜索你的研究</span><kbd>Ctrl K</kbd></button>
  <nav class="main-nav" aria-label="项目中心"><button class="selected" data-view="projects">${icon('grid')}我的项目<span id="nav-count">3</span></button><button data-toast="团队协作页面将在后续视觉方案中展开">${icon('users')}团队项目</button><button data-toast="收集箱沿用现有产品功能，本页只演示主要布局">${icon('inbox')}收集箱<span>2</span></button></nav>
  <div class="sidebar-label">收藏的项目</div><button class="favorite" data-open="主动智能体"><i class="dot sage"></i>主动智能体</button><button class="favorite" data-open="长期记忆"><i class="dot clay"></i>长期记忆</button>
  <div class="sidebar-footer"><div class="avatar">研</div><div><strong>我的研究空间</strong><small>本地优先 · 示例账号</small></div><button class="icon" data-toast="独立原型，不会修改应用设置" aria-label="设置">···</button></div></aside>
  <main class="project-main"><header class="page-toolbar"><span>个人空间</span><button class="quiet sync" data-sync>${icon('cloud')}已同步</button></header>
  <div class="project-scroll"><div class="page-heading"><div><p class="eyebrow">YOUR RESEARCH LIBRARY</p><h1>我的项目<span id="project-count">03</span></h1><p class="subtle">把论文、思考和下一步研究，放在一起。</p></div><button class="primary" id="new-project">${icon('plus')}新建项目</button></div>
  <section class="resume" aria-label="继续研究"><div class="resume-mark">${icon('book')}</div><div><span class="subtle small">上次读到 · 主动智能体</span><h2>Learning when to act</h2><p>第 4 页，共 18 页 <span class="separator">/</span> 关于主动决策的阅读笔记</p></div><button class="quiet" data-open="主动智能体">继续阅读${icon('arrow')}</button></section>
  <div class="collection-heading"><div class="filter-group" aria-label="筛选项目"><button class="active" data-filter="all" aria-pressed="true">全部项目 <span id="filter-count">3</span></button><button data-filter="favorite" aria-pressed="false">收藏 <span>2</span></button></div><div class="collection-tools"><button id="sort" class="quiet small">最近打开 ↓</button><div class="segment view-mode"><button id="grid-mode" aria-label="书架视图" aria-pressed="true">${icon('grid')}</button><button id="list-mode" aria-label="列表视图" aria-pressed="false">${icon('list')}</button></div></div></div>
  <section class="books" id="project-collection" aria-label="项目列表"></section>
  <section class="recent"><div class="section-heading"><h2>最近更新</h2><span class="subtle small">研究在这里继续</span></div>
  <button class="recent-row" data-open="主动智能体"><span class="file-icon">${icon('note')}</span><span><strong>主动决策与任务执行的边界</strong><small>主动智能体 · 研究笔记</small></span><time>10 分钟前</time>${icon('chevron')}</button>
  <button class="recent-row" data-open="长期记忆"><span class="file-icon">${icon('doc')}</span><span><strong>Memory as a foundation for adaptive agents</strong><small>长期记忆 · 文献</small></span><time>昨天</time>${icon('chevron')}</button></section></div></main>`;
function renderProjects(){
  let items=projects.filter(p=>filter==='all'||p.favorite);
  if(reverse)items=[...items].reverse();
  $('#project-collection').innerHTML=items.map(p=>`<article class="book-item"><button class="book-link" data-open="${esc(p.name)}"><div class="cover ${p.color}"><div class="cover-top">SCIENTIFY RESEARCH<span>0${projects.indexOf(p)+1}</span></div><div class="cover-pattern" aria-hidden="true"></div><div class="cover-title"><small>${esc(p.en)}</small><strong>${esc(p.name)}</strong><span>${esc(p.subtitle)}</span></div><span class="cover-bottom">研究札记 ${icon('arrow')}</span></div><div class="book-info"><h2>${esc(p.name)}</h2><p>${p.papers} 篇文献 <span>·</span> ${p.notes} 篇笔记</p><small>${p.date}</small></div></button></article>`).join('');
  $('#project-count').textContent=String(projects.length).padStart(2,'0');
  $('#nav-count').textContent=$('#filter-count').textContent=projects.length;
}
renderProjects();
$('#reader-view').innerHTML=`
  <aside class="rail"><button class="brand-icon" data-view="projects" aria-label="返回项目中心">${logo}</button><button class="rail-item active" id="library-toggle" aria-pressed="true">${icon('book')}<span>文献</span></button><button class="rail-item" data-panel="notes">${icon('note')}<span>笔记</span></button><div class="rail-bottom"><button class="rail-item" data-view="projects">${icon('grid')}<span>项目</span></button></div></aside>
  <div class="research-body"><header class="research-header"><div class="breadcrumbs"><span id="project-name">主动智能体</span><span>/</span><strong>文献阅读</strong></div><div class="header-actions"><button class="icon" data-search aria-label="搜索" title="搜索 Ctrl K">${icon('search')}</button><button class="quiet sync" data-sync>${icon('cloud')}<span>已同步</span></button><button class="quiet panel-trigger" data-panel="notes">${icon('note')}笔记</button><button class="primary panel-trigger" data-panel="ai">${icon('ai')}AI 助手</button></div></header>
  <div class="research-columns"><aside class="library" aria-label="文献列表"><div class="library-header"><strong>文献库 <span>24</span></strong><button class="icon" id="library-close" aria-label="收起文献列表">${icon('panel')}</button></div><label class="library-search">${icon('search')}<input id="paper-filter" placeholder="查找文献" aria-label="查找文献"></label><p class="sidebar-label">主动决策与上下文</p><div class="paper-list">${papers.map((p,i)=>`<button class="paper-item ${i===0?'selected':''}" data-paper="${p}" title="${p}">${icon('doc')}<span><strong>${p}</strong><small>${i===0?'2026 · 读至第 4 页':'2026 · 示例文献'}</small></span></button>`).join('')}</div><div class="library-foot"><i class="dot sage"></i>本地文献 <span>24 篇</span></div></aside>
  <main class="reader"><div class="document-tab"><span>${icon('doc')}<strong id="document-name">Learning when to act</strong></span><button class="icon" id="outline-toggle" aria-label="标题目录" aria-expanded="false">${icon('list')}</button></div><div class="paper-scroll" id="paper-scroll"><article class="paper" id="paper">
  <div class="paper-kicker">RESEARCH NOTES <span>SCIENTIFY DEMO / 2026</span></div><h1 id="paper-title">Learning when to act</h1><p class="paper-subtitle">A framework for context-aware proactive assistance</p><p class="authors">Scientify Research · 示例论文，非真实出版物</p>
  <section id="abstract"><h2>Abstract</h2><p>Useful assistance begins with understanding when help is needed. We explore a framework that separates the decision to intervene from the generation of a response, while preserving a continuous view of the surrounding context.</p></section>
  <section id="method"><h2>1. From observation to action</h2><p>A proactive system should remain attentive without interrupting unnecessarily. The timing policy considers the current context, the expected benefit of an intervention, and the cost of distracting the user.</p><figure><div class="flow-diagram"><div><span>01</span>Observe<small>持续感知</small></div><b>→</b><div class="flow-emphasis"><span>02</span>Decide<small>判断时机</small></div><b>→</b><div><span>03</span>Respond<small>执行与反馈</small></div></div><figcaption>Figure 1. Separate timing decisions from response generation.</figcaption></figure><p>This separation allows the observation stream to continue while an earlier response is being produced. Memory provides continuity; the timing policy selects the moment to act.</p></section>
  <section id="discussion"><h2>2. Design implications</h2><p>Evaluation should account for both helpful interventions and appropriate silence. A system that responds more often is not necessarily more useful. The objective is timely, grounded assistance.</p><blockquote>Understanding when to remain silent is part of understanding when to help.</blockquote></section><div class="paper-page">4</div></article></div>
  <nav class="reading-controls" aria-label="阅读工具"><button class="icon" id="prev-page" aria-label="上一页">‹</button><span><strong id="page-number">4</strong> / 18</span><button class="icon" id="next-page" aria-label="下一页">›</button><i></i><button id="zoom-out" aria-label="缩小">−</button><button id="fit-width" title="恢复适应宽度">适应宽度</button><button id="zoom-in" aria-label="放大">+</button></nav>
  <nav class="outline" id="outline" aria-label="论文标题目录" hidden><strong>本文目录</strong><button data-anchor="abstract">摘要</button><button data-anchor="method">1. 从观察到行动</button><button data-anchor="discussion">2. 设计启示</button></nav></main>
  <button class="inspector-backdrop" id="inspector-backdrop" aria-label="关闭辅助面板" hidden></button>
  <aside class="inspector" id="inspector" aria-label="研究辅助面板"><div class="resize-handle" id="resize-handle" role="separator" tabindex="0" aria-label="调整辅助面板宽度" aria-orientation="vertical" aria-valuemin="300" aria-valuemax="440" aria-valuenow="352"></div>
  <header class="inspector-header"><div class="panel-tabs" role="tablist" aria-label="辅助工具"><button role="tab" id="ai-tab" data-panel="ai" aria-selected="true" aria-controls="ai-panel">${icon('ai')}AI 助手</button><button role="tab" id="notes-tab" data-panel="notes" aria-selected="false" aria-controls="notes-panel" tabindex="-1">${icon('note')}论文笔记</button></div><button class="icon" id="panel-close" aria-label="关闭辅助面板">${icon('close')}</button></header>
  <section class="panel-content" id="ai-panel" role="tabpanel" aria-labelledby="ai-tab"><div class="session-bar"><button id="session-menu">理解主动决策 <span>⌄</span></button><button class="icon" id="new-session" aria-label="新建演示会话">${icon('plus')}</button></div><div class="messages" id="messages">
  <div class="user-message">这篇论文为什么把决策与回复分开？</div><div class="assistant-message"><p>它将两个不同的问题分开处理：<strong>现在是否需要介入</strong>，以及<strong>介入后如何提供帮助</strong>。</p><h3>持续观察，不必持续打断</h3><p>时机模块持续接收上下文；回复模块只在确实需要时开始工作。因此，生成回答不会阻断新的观察。</p><div class="insight"><span>阅读重点</span><p>评估的不只是“回答得好不好”，还包括“此时是否应该回答”。</p></div><p>你可以结合文中的流程图，比较两类模块各自接收什么信息。</p><button class="text-action" id="save-to-note">${icon('note')}记到论文笔记</button></div></div>
  <div class="composer-wrap"><div class="context-chip">${icon('doc')}<span>当前论文</span><span class="subtle">已关联</span></div><form id="composer"><label class="sr-only" for="prompt">向 AI 提问</label><textarea id="prompt" rows="2" placeholder="围绕这篇论文继续思考…"></textarea><div class="composer-tools"><button type="button" class="model" data-toast="模拟回复，不调用任何模型服务">研究助手 <span>⌄</span></button><button type="button" class="permission" id="permission">询问后执行</button><button type="submit" class="send" id="send" aria-label="发送">${icon('send')}</button></div></form><p class="composer-caption" id="generation-status" role="status">演示回复 · 不会调用模型或操作文件</p></div></section>
  <section class="panel-content notes-content" id="notes-panel" role="tabpanel" aria-labelledby="notes-tab" hidden><div class="note-meta"><span>论文笔记</span><span id="note-status" role="status">演示草稿</span></div><h2>主动决策的边界</h2><p class="note-hint">为自己的研究留下判断，而不只是摘要。</p><label class="sr-only" for="note-editor">笔记正文</label><textarea id="note-editor" spellcheck="false"></textarea><div class="note-footer"><span>这里是纯文本示意，正式版沿用 Markdown 编辑器。</span><button id="save-note" class="quiet">保存演示草稿</button></div></section></aside></div>
  <footer class="workspace-status"><span><i class="dot sage"></i>阅读位置已保留</span><span id="layout-status">内容优先布局</span><span>示例项目 · 无真实数据</span></footer></div>`;
$('#note-editor').value='核心观点\n\n将“是否介入”和“如何回复”分开建模，让观察能够持续进行。\n\n值得继续追问\n\n怎样量化一次不必要打断的成本？\n评估时是否也应奖励恰当的沉默？';
function toast(message){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,3500);}
function changeView(next){
  if(next===view)return;
  const update=()=>{view=next;$('#projects-view').hidden=next!=='projects';$('#reader-view').hidden=next!=='reader';document.querySelectorAll('.review-bar [data-view]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.view===next));layout();};
  if(document.startViewTransition&&!matchMedia('(prefers-reduced-motion: reduce)').matches)document.startViewTransition(update);else update();
}
function layout(){
  const width=$('#frame').clientWidth;
  const inspectorWidth=panelOpen?Number($('#resize-handle').getAttribute('aria-valuenow')):0;
  const collapsed=width<Math.max(1120,64+234+560+inspectorWidth);
  $('#frame').classList.toggle('resource-collapsed',collapsed||libraryManual==='closed');
  $('#frame').classList.toggle('resource-overlay',collapsed&&libraryManual==='open');
  $('#frame').classList.toggle('panel-overlay',width<1000);
  $('#inspector-backdrop').hidden=!(panelOpen&&width<1000&&view==='reader');
  $('#library-toggle').setAttribute('aria-pressed',(!collapsed&&libraryManual!=='closed')||libraryManual==='open');
  $('#layout-status').textContent=width<1000?'辅助工具浮层 · 保留正文宽度':collapsed?'已收起资源栏 · 优先阅读':'阅读与辅助工具并排';
}
new ResizeObserver(layout).observe($('#frame'));
function showPanel(next,focus=false){
  panel=next;panelOpen=true;$('#inspector').hidden=false;
  for(const name of ['ai','notes']){$('#'+name+'-panel').hidden=next!==name;$('#'+name+'-tab').setAttribute('aria-selected',next===name);$('#'+name+'-tab').tabIndex=next===name?0:-1;}
  layout();if(focus)$('#'+next+'-tab').focus();
}
function closePanel(){panelOpen=false;$('#inspector').hidden=true;layout();document.querySelector('[data-panel="'+panel+'"].panel-trigger').focus();}
function openProject(name){$('#project-name').textContent=name;changeView('reader');}
document.addEventListener('click',event=>{
  const t=event.target.closest('button,a');if(!t)return;
  if(t.dataset.view){event.preventDefault();changeView(t.dataset.view);}
  if(t.dataset.open)openProject(t.dataset.open);
  if(t.dataset.panel)showPanel(t.dataset.panel);
  if(t.hasAttribute('data-search')){$('#search-dialog').showModal();$('#global-search').value='';search();$('#global-search').focus();}
  if(t.dataset.toast)toast(t.dataset.toast);
  if(t.hasAttribute('data-close-dialog'))t.closest('dialog').close();
  if(t.hasAttribute('data-sync'))toast('示例状态：所有更改已同步。原型不会访问服务器。');
  if(t.dataset.filter){filter=t.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>{b.classList.toggle('active',b.dataset.filter===filter);b.setAttribute('aria-pressed',b.dataset.filter===filter);});renderProjects();}
  if(t.dataset.paper){$('#document-name').textContent=$('#paper-title').textContent=t.dataset.paper;document.querySelectorAll('[data-paper]').forEach(b=>b.classList.toggle('selected',b===t));$('#paper-scroll').scrollTop=0;libraryManual=false;layout();toast('已切换示例标题；论文正文为同一份排版示意。');}
  if(t.dataset.anchor){$('#'+t.dataset.anchor).scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});$('#outline').hidden=true;$('#outline-toggle').setAttribute('aria-expanded','false');}
  if(t.id==='save-to-note'){$('#note-editor').value+='\n\n阅读补充\n评估的不只是“回答得好不好”，还包括“此时是否应该回答”。';$('#note-status').textContent='未保存';showPanel('notes');toast('内容已加入演示笔记');}
});
$('#guide-open').onclick=()=>$('#guide').showModal();
$('#width-toggle').onclick=e=>{const narrow=$('#frame').classList.toggle('narrow');e.currentTarget.setAttribute('aria-pressed',narrow);e.currentTarget.textContent=narrow?'恢复宽窗口':'窄窗口';};
$('#theme-toggle').onclick=()=>{const dark=document.body.dataset.theme!=='dark';document.body.dataset.theme=dark?'dark':'light';$('#theme-toggle').setAttribute('aria-label',dark?'切换浅色主题':'切换深色主题');};
$('#sort').onclick=()=>{reverse=!reverse;$('#sort').textContent=reverse?'最早打开 ↑':'最近打开 ↓';renderProjects();};
for(const mode of ['list','grid'])$('#'+mode+'-mode').onclick=()=>{$('#project-collection').classList.toggle('list',mode==='list');$('#list-mode').setAttribute('aria-pressed',mode==='list');$('#grid-mode').setAttribute('aria-pressed',mode==='grid');};
$('#new-project').onclick=()=>$('#new-dialog').showModal();
$('#new-form').onsubmit=e=>{e.preventDefault();const name=$('#project-title').value.trim();if(!name)return;projects.push({name,en:'NEW RESEARCH',subtitle:'A new line of inquiry',color:'sage',papers:0,notes:0,date:'刚刚创建',favorite:false});renderProjects();$('#new-dialog').close();$('#project-title').value='';openProject(name);toast('已创建演示项目。阅读区展示通用示例，刷新后恢复。');};
$('#library-toggle').onclick=()=>{libraryManual=$('#library-toggle').getAttribute('aria-pressed')==='true'?'closed':'open';layout();};
$('#library-close').onclick=()=>{libraryManual='closed';layout();$('#library-toggle').focus();};
$('#paper-filter').oninput=e=>{const term=e.target.value.toLowerCase();document.querySelectorAll('[data-paper]').forEach(b=>b.hidden=!b.dataset.paper.toLowerCase().includes(term));};
$('#panel-close').onclick=$('#inspector-backdrop').onclick=closePanel;
$('#outline-toggle').onclick=()=>{const open=$('#outline').hidden;$('#outline').hidden=!open;$('#outline-toggle').setAttribute('aria-expanded',open);};
$('.panel-tabs').onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();showPanel(panel==='ai'?'notes':'ai',true);}};
function changePage(delta){page=Math.max(1,Math.min(18,page+delta));$('#page-number').textContent=page;$('.paper-page').textContent=page;$('#paper-scroll').scrollTop=0;toast('演示页码 '+page+' / 18，正文为布局示例');}
$('#prev-page').onclick=()=>changePage(-1);$('#next-page').onclick=()=>changePage(1);
function setZoom(next){zoom=Math.max(80,Math.min(150,next));$('#paper').style.width=zoom+'%';$('#paper').style.maxWidth=740*zoom/100+'px';$('#fit-width').textContent=zoom===100?'适应宽度':zoom+'%';}
$('#zoom-in').onclick=()=>setZoom(zoom+10);$('#zoom-out').onclick=()=>setZoom(zoom-10);$('#fit-width').onclick=()=>setZoom(100);
$('#note-editor').oninput=()=>$('#note-status').textContent='未保存';
$('#save-note').onclick=()=>{$('#note-status').textContent='本页已保留';toast('草稿保留在本页内存中，刷新后恢复示例。');};
$('#permission').onclick=()=>{$('#permission').textContent=$('#permission').textContent==='询问后执行'?'完全允许':'询问后执行';toast('仅演示权限选择，未更改应用权限。');};
const sessions=[{name:'理解主动决策',html:$('#messages').innerHTML}];let sessionIndex=0;
function saveSession(){sessions[sessionIndex].html=$('#messages').innerHTML;}
function stopStream(stopped=true){if(!stream)return;clearInterval(stream);stream=null;$('#send').innerHTML=icon('send');$('#send').setAttribute('aria-label','发送');$('#generation-status').textContent=stopped?'已中止 · 可修改问题后继续':'演示回复已完成 · 未调用模型';saveSession();}
$('#new-session').onclick=()=>{stopStream();saveSession();sessions.push({name:'新会话 '+sessions.length,html:'<p class="subtle">从一个问题开始。当前论文已关联。</p>'});sessionIndex=sessions.length-1;$('#messages').innerHTML=sessions[sessionIndex].html;$('#session-menu').textContent=sessions[sessionIndex].name+' ⌄';$('#prompt').focus();};
$('#session-menu').onclick=()=>{if(sessions.length===1){toast('点击右侧加号创建第二个会话，再点击这里切换。');return;}stopStream();saveSession();sessionIndex=(sessionIndex+1)%sessions.length;$('#messages').innerHTML=sessions[sessionIndex].html;$('#session-menu').textContent=sessions[sessionIndex].name+' ⌄';};
$('#composer').onsubmit=e=>{
  e.preventDefault();if(stream){stopStream();return;}const prompt=$('#prompt').value.trim();if(!prompt)return;
  const user=document.createElement('div');user.className='user-message';user.textContent=prompt;$('#messages').append(user);
  const answer=document.createElement('div');answer.className='assistant-message';const paragraph=document.createElement('p');answer.append(paragraph);$('#messages').append(answer);$('#prompt').value='';
  const response='可以从“介入时机”和“执行质量”两个层面分析。前者关注当前是否值得打断用户，后者关注决定行动后如何准确完成任务。把二者分离后，观察可以持续进行，生成回复也不会阻断后续信息。\n\n阅读时可以重点比较：时机模块使用了哪些上下文？系统如何衡量一次不必要介入的成本？这些问题会帮助你形成自己的判断。';
  paragraph.style.whiteSpace='pre-wrap';let position=0;
  $('#send').textContent='■';$('#send').setAttribute('aria-label','中止回复');$('#generation-status').innerHTML='<span class="loading-ring" aria-hidden="true"></span>正在生成演示回复 · 仍可输入下一条问题';
  stream=setInterval(()=>{const area=$('#messages'),follow=area.scrollHeight-area.clientHeight-area.scrollTop<90;position+=3;paragraph.textContent=response.slice(0,position);if(follow)area.scrollTop=area.scrollHeight;if(position>=response.length)stopStream(false);},35);
  $('#messages').scrollTop=$('#messages').scrollHeight;
};
$('#prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!stream)$('#composer').requestSubmit();else toast('回复中可以编辑下一条问题；点击停止后再发送。');}};
function search(){
  const term=$('#global-search').value.toLowerCase();
  const items=[...projects.map(p=>({label:p.name,project:p.name})),...papers.map(p=>({label:p,project:'主动智能体'}))].filter(p=>p.label.toLowerCase().includes(term));
  $('#search-results').replaceChildren(...items.map(p=>{const b=document.createElement('button');b.textContent=p.label;b.onclick=()=>{$('#search-dialog').close();openProject(p.project);if(papers.includes(p.label))$('#document-name').textContent=$('#paper-title').textContent=p.label;};return b;}));
  if(!items.length)$('#search-results').textContent='没有匹配的示例内容';
}
$('#global-search').oninput=search;
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if(!document.querySelector('dialog[open]')){$('#search-dialog').showModal();search();$('#global-search').focus();}}
  if(e.key==='Escape'&&!document.querySelector('dialog[open]')){if(!$('#outline').hidden){$('#outline').hidden=true;$('#outline-toggle').setAttribute('aria-expanded','false');$('#outline-toggle').focus();}else if(view==='reader'&&panelOpen)closePanel();}
});
const handle=$('#resize-handle');let drag;
function setPanelWidth(width){const next=Math.max(300,Math.min(440,width));$('#frame').style.setProperty('--inspector-width',next+'px');handle.setAttribute('aria-valuenow',Math.round(next));layout();}
handle.onpointerdown=e=>{if(e.button!==0)return;drag={x:e.clientX,width:$('#inspector').getBoundingClientRect().width};handle.setPointerCapture(e.pointerId);document.body.style.userSelect='none';};
handle.onpointermove=e=>{if(drag)setPanelWidth(drag.width+drag.x-e.clientX);};
handle.onpointerup=handle.onpointercancel=()=>{drag=null;document.body.style.userSelect='';};
handle.onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setPanelWidth(Number(handle.getAttribute('aria-valuenow'))+(e.key==='ArrowLeft'?16:-16));}};
layout();
