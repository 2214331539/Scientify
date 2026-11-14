'use strict';
/* Scientify redesign prototype, v2. Fictional data; no network, files or models.
   The project center is the entry. Inside a project the sidebar holds its four modules
   and the active module's own resources; AI and notes open on the right. */

const ICONS = {
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  note: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  flask: '<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
  pen: '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  sidebar: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  fwd: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  filter: '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
  sort: '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="1"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  mark: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  quote: '<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  userplus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  zin: '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>',
  zout: '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="8" x2="14" y1="11" y2="11"/>',
  toc: '<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  minus: '<path d="M5 12h14"/>',
  square: '<rect width="16" height="16" x="4" y="4" rx="1"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5"/>',
  ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  chart: '<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>',
  translate: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  ai: '<path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><circle cx="12" cy="12" r="4"/>',
  max: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  updown: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  rss: '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
};
const icon = (name, cls = '') =>
  `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const LOGO = '../../../../public/brand/';

/* ---------------- Data (fictional) ---------------- */
const people = { 潘: '潘子禾', 李: '李嘉', 王: '王悦', 周: '周可' };
const phones = { 潘: '138****6688', 李: '139****2051', 王: '186****7720', 周: '135****0913' };
const projects = [
  { id: 'proactive', name: 'Proactive', field: 'Agent · 具身', question: '智能体如何在用户开口之前，判断该不该介入、何时介入？', tone: '#4f5866', team: true, role: '所有者', owner: '潘', members: ['潘', '李', '王'], sync: 'ok', opened: '刚刚', fav: true },
  { id: 'memory', name: 'Agent Memory', field: 'Agent', question: '长程任务中，智能体记忆的写入、遗忘与检索怎样取舍？', tone: '#6a5f53', team: true, role: '编辑者', owner: '王', members: ['王', '潘'], sync: 'ok', opened: '昨天', fav: true },
  { id: 'vla', name: 'VLA Survey', field: '综述', question: '视觉-语言-动作模型：分类框架与评测。', tone: '#5b6470', team: true, role: '审阅者', owner: '周', members: ['周', '潘', '李'], sync: 'ok', opened: '11 月 8 日' },
  { id: 'foundation', name: 'Foundation', field: '基础模型', question: '科学基础模型的评测基准与数据配方。', tone: '#55625a', team: false, role: '所有者', sync: 'conflict', opened: '3 天前' },
  { id: 'thesis', name: '学位论文', field: '博士论文', question: '主动式智能体的时机建模。', tone: '#6b6157', team: false, role: '所有者', sync: 'local', opened: '上周', fav: true },
  { id: 'robot', name: 'Home Robot', field: '具身', question: '家用机器人在开放环境中的长程任务规划。', tone: '#5a5f66', team: false, role: '所有者', sync: 'ok', opened: '昨天' },
  { id: 'llmeval', name: '评测方法阅读', field: '评测', question: '大模型评测方法的阅读与整理。', tone: '#64605a', team: false, role: '所有者', sync: 'local', opened: '11 月 2 日' },
  { id: 'ego', name: 'Egocentric Intent', field: '视频理解', question: '第一视角视频中的意图识别与预测。', tone: '#5e5a6b', team: false, role: '所有者', sync: 'local', opened: '9 月 28 日', archived: true },
];
const elsewhere = [{ id: 'reading', name: 'Reading Group', tone: '#6a6358', device: 'MacBook Air', at: '11 月 9 日' }];
const invites = [{ id: 'embodied', name: 'Embodied Eval', field: '评测', question: '具身智能评测的统一协议与基准。', tone: '#58615e', from: '李', role: '查看者', members: ['李', '周', '王', '潘'], at: '今天 11:02' }];
const counts = {
  proactive: { papers: 10, notes: 5, exps: 3, ms: 2 },
  memory: { papers: 21, notes: 11, exps: 2, ms: 1 },
  vla: { papers: 64, notes: 9, exps: 0, ms: 1 },
  foundation: { papers: 14, notes: 4, exps: 1, ms: 0 },
  thesis: { papers: 48, notes: 26, exps: 3, ms: 1 },
  ego: { papers: 8, notes: 6, exps: 2, ms: 0 },
};
const countsOf = (id) => counts[id] || { papers: 12, notes: 3, exps: 1, ms: 0 };

const groups = [
  { id: 'all', name: '全部论文', icon: 'book' },
  { id: 'unread', name: '未读', icon: 'clock' },
  { id: 'reading', name: '在读', icon: 'note' },
  { id: 'star', name: '收藏', icon: 'star' },
];
const dirs = ['Decision Model', 'Benchmarks', 'Memory', 'Streaming Video'];
const papers = [
  { id: 'p1', title: 'Proactive Physical AI through Continuous Observation and Timely Intervention', short: 'Proactive Physical AI', authors: 'Z. Yang, J. Liang, X. Zhou, Y. Jiang 等', year: 2026, venue: 'arXiv', dir: 'Decision Model', status: 'reading', progress: 36, page: 12, pages: 33, notes: 2, added: '今天', star: true, tags: ['时机模型', '具身'] },
  { id: 'p2', title: 'Proactive Agent: Shifting LLM Agents from Reactive Responses to Active Assistance', short: 'Proactive Agent', authors: 'Y. Lu, S. Yang, C. Qian 等', year: 2025, venue: 'ICLR', dir: 'Decision Model', status: 'read', progress: 100, page: 18, pages: 18, notes: 3, added: '10 月 29 日', star: true, tags: ['数据集', '奖励模型'] },
  { id: 'p3', title: 'ProactiveBench: Benchmarking Proactiveness of Conversational Agents', short: 'ProactiveBench', authors: 'H. Chen, R. Zhao 等', year: 2025, venue: 'ACL', dir: 'Benchmarks', status: 'unread', progress: 0, page: 1, pages: 22, notes: 0, added: '11 月 10 日', tags: ['评测'] },
  { id: 'p4', title: 'OVO-Bench: How Far is Your Video-LLM from Real-World Online Video Understanding?', short: 'OVO-Bench', authors: 'Y. Li, J. Niu 等', year: 2025, venue: 'CVPR', dir: 'Benchmarks', status: 'read', progress: 100, page: 16, pages: 16, notes: 1, added: '10 月 21 日', tags: ['评测', '流式视频'] },
  { id: 'p5', title: 'LightMem: Lightweight and Efficient Memory-Augmented Generation', short: 'LightMem', authors: 'J. Fang, X. Deng 等', year: 2025, venue: 'arXiv', dir: 'Memory', status: 'reading', progress: 60, page: 14, pages: 24, notes: 1, added: '11 月 2 日', tags: ['记忆'] },
  { id: 'p6', title: 'Proactive Assistant Dialogue Generation from Streaming Egocentric Videos', short: 'Proactive Assistant Dialogue', authors: 'Y. Zhang, X. Dong 等', year: 2025, venue: 'EMNLP', dir: 'Streaming Video', status: 'reading', progress: 20, page: 4, pages: 21, notes: 0, added: '11 月 8 日', tags: ['第一视角'] },
  { id: 'p7', title: 'ProAgent: Building Proactive Cooperative Agents with Large Language Models', short: 'ProAgent', authors: 'C. Zhang, K. Yang 等', year: 2024, venue: 'AAAI', dir: 'Decision Model', status: 'read', progress: 100, page: 12, pages: 12, notes: 2, added: '9 月 30 日', tags: ['协作'] },
  { id: 'p8', title: 'VideoLLM-online: Online Video Large Language Model for Streaming Video', short: 'VideoLLM-online', authors: 'J. Chen, Z. Lv 等', year: 2024, venue: 'CVPR', dir: 'Streaming Video', status: 'read', progress: 100, page: 14, pages: 14, notes: 1, added: '9 月 26 日', tags: ['流式视频'] },
  { id: 'p9', title: 'StreamBridge: Turning Your Offline Video LLM into a Proactive Streaming Assistant', short: 'StreamBridge', authors: 'H. Wang, B. Feng 等', year: 2025, venue: 'arXiv', dir: 'Streaming Video', status: 'unread', progress: 0, page: 1, pages: 19, notes: 0, added: '11 月 12 日', tags: ['流式视频'] },
  { id: 'p10', title: 'EgoLife: Towards Egocentric Life Assistant', short: 'EgoLife', authors: 'J. Yang, S. Liu 等', year: 2025, venue: 'CVPR', dir: 'Streaming Video', status: 'unread', progress: 0, page: 1, pages: 28, notes: 0, added: '11 月 12 日', tags: ['第一视角'] },
];
const sources = [
  { id: 'pa', name: 'proactive agent', kind: 'arXiv 关键词' },
  { id: 'sv', name: 'streaming video LLM', kind: 'arXiv 关键词' },
  { id: 'cite', name: '引用了 ProAgent', kind: 'Semantic Scholar' },
];
const sites = ['arXiv', 'OpenReview', 'Semantic Scholar'];
const feed = [
  { id: 's1', when: '今天', src: 'pa', title: 'When to Speak: Learning Intervention Timing for Always-On Assistants', authors: 'K. Liu, M. Xu 等', venue: 'arXiv 2511.08812' },
  { id: 's2', when: '今天', src: 'sv', title: 'StreamMem: Query-Agnostic KV Cache Memory for Streaming Video Understanding', authors: 'Y. Yang, Z. Zhao 等', venue: 'arXiv 2511.08530' },
  { id: 's3', when: '今天', src: 'pa', title: 'ProactiveEval: A Unified Evaluation Framework for Proactive Dialogue Agents', authors: 'T. Liu, X. Wang 等', venue: 'arXiv 2511.08217' },
  { id: 's4', when: '昨天', src: 'cite', title: 'Beyond Reactive: A Survey of Proactive Conversational and Embodied Agents', authors: 'R. Gao, H. Li 等', venue: 'arXiv 2511.07730' },
  { id: 's5', when: '昨天', src: 'sv', title: 'LiveStar: Live Streaming Assistant for Real-World Online Video Understanding', authors: 'Z. Yang, Y. Wang 等', venue: 'NeurIPS 2025' },
  { id: 's6', when: '昨天', src: 'pa', title: 'Ask Before You Act: Uncertainty-Aware Proactive Help in Household Robots', authors: 'J. Park, S. Kim 等', venue: 'arXiv 2511.07104' },
  { id: 's7', when: '本周', src: 'pa', title: 'Silent Until Needed: Cost-Aware Interruption Policies for Desktop Agents', authors: 'A. Chen, P. Zhou 等', venue: 'arXiv 2511.05561' },
];
const notes = [
  { id: 'n1', title: '决策模型与响应模型的分工', when: '今天', time: '2 小时前', excerpt: '决策模型回答“要不要介入、何时介入”，响应模型回答“对谁说、说什么、做什么”。两者共享同一条观察流……', sources: 2, tags: ['方法'] },
  { id: 'n2', title: 'ProAgent 方法拆解', when: '昨天', time: '昨天 21:40', excerpt: '训练数据来自真实活动轨迹，奖励模型对“该不该主动”打分……', sources: 1, tags: ['方法'] },
  { id: 'n3', title: '评测指标对比：ProactiveBench vs OVO-Bench', when: '本周', time: '11 月 10 日', excerpt: '一个看对话中的主动性，一个看流式视频里的实时理解；时机误差的定义不同……', sources: 2, tags: ['评测'] },
  { id: 'n4', title: '实验设计草稿：时机模型消融', when: '本周', time: '11 月 9 日', excerpt: '去掉音频、去掉状态上下文、缩短观察窗口，分别看误触发率和延迟……', sources: 0, tags: ['实验'] },
  { id: 'n5', title: '组会记录 11-06', when: '更早', time: '11 月 6 日', excerpt: '下周前跑完 timing-abl 三组；李嘉负责整理 Benchmarks 的评测脚本……', sources: 0, tags: ['组会'] },
];
const trashed = [
  { id: 't1', title: '旧版实验设计（作废）', excerpt: '最初打算把时机判断和回复生成放在一个模型里……', time: '2 天前删除' },
  { id: 't2', title: '未命名', excerpt: '', time: '5 天前删除' },
];
const noteTags = ['方法', '评测', '实验', '组会'];
const experiments = [
  { id: 'timing', name: 'timing-model', desc: '时机模型：输入消融与窗口长度', code: '托管目录', py: 'Python 3.11 · venv', last: 'run', lastText: 'timing-abl-04 运行中', updated: '18 分钟前' },
  { id: 'baseline', name: 'baseline-repro', desc: '复现 VideoLLM-online 基线', code: 'D:\\code\\videollm-online', py: 'Python 3.10 · conda', last: 'bad', lastText: 'baseline-r2 失败', updated: '昨天' },
  { id: 'data', name: 'data-pipeline', desc: '把第一视角视频转成时机标签', code: '托管目录', py: '未配置 Python', last: 'none', lastText: '还没有运行', updated: '11 月 6 日' },
];
const runs = [
  { id: 'r6', exp: 'timing', name: 'timing-abl-04', cfg: '去掉音频 · 窗口 8s', state: 'run', started: '18 分钟前', dur: '18m', f1: '—', lat: '—', note: 'epoch 7 / 20' },
  { id: 'r5', exp: 'timing', name: 'timing-abl-03', cfg: '完整输入 · 窗口 8s', state: 'ok', started: '今天 10:12', dur: '42m', f1: '0.712', lat: '142', best: true },
  { id: 'r4', exp: 'timing', name: 'timing-abl-02', cfg: '去掉状态 · 窗口 8s', state: 'ok', started: '昨天 22:05', dur: '39m', f1: '0.688', lat: '156' },
  { id: 'r1', exp: 'timing', name: 'timing-abl-01', cfg: '完整输入 · 窗口 4s', state: 'ok', started: '11 月 10 日', dur: '40m', f1: '0.655', lat: '171' },
  { id: 'r3', exp: 'baseline', name: 'baseline-r2', cfg: 'VideoLLM-online 基线', state: 'bad', started: '昨天 19:40', dur: '6m', f1: '—', lat: '—', note: 'CUDA out of memory' },
  { id: 'r2', exp: 'baseline', name: 'baseline-r1', cfg: 'VideoLLM-online 基线', state: 'ok', started: '11 月 11 日', dur: '35m', f1: '0.641', lat: '98' },
];
const tree = [
  { dir: 'configs', depth: 0 },
  { path: 'configs/train.yaml', depth: 1 },
  { path: 'configs/ablation.yaml', depth: 1, git: 'A' },
  { dir: 'src', depth: 0 },
  { path: 'src/data.py', depth: 1 },
  { path: 'src/model.py', depth: 1, git: 'M' },
  { path: 'src/train.py', depth: 1 },
  { dir: 'outputs', depth: 0, closed: true },
  { path: 'README.md', depth: 0 },
  { path: 'requirements.txt', depth: 0 },
];
const files = {
  'src/train.py': `import yaml
import torch
from torch.utils.data import DataLoader

from data import StreamDataset
from model import TimingModel


def train(config_path: str, drop: str | None = None):
    cfg = yaml.safe_load(open(config_path))
    model = TimingModel(cfg["model"], drop=drop).cuda()
    data = DataLoader(StreamDataset(cfg["data"]), batch_size=8)
    optim = torch.optim.AdamW(model.parameters(), lr=2e-5)

    for epoch in range(cfg["epochs"]):
        for batch in data:
            loss = model(batch).loss  # 只训练时机头
            loss.backward()
            optim.step()
            optim.zero_grad()
        f1, latency = evaluate(model, cfg["val"])
        print(f"[epoch {epoch + 1}/{cfg['epochs']}] val_f1 {f1:.3f}  lat {latency}ms")

    return model`,
  'src/model.py': `import torch.nn as nn


class TimingModel(nn.Module):
    """判断此刻要不要介入；不生成回复。"""

    def __init__(self, cfg, drop=None):
        super().__init__()
        self.encoder = StreamEncoder(cfg)
        # 时机头只判断要不要介入；响应头单独训练
        self.timing_head = nn.Linear(cfg.hidden, 2)
        self.drop = set(drop or [])

    def forward(self, batch):
        audio = None if "audio" in self.drop else batch.audio
        state = None if "state" in self.drop else batch.state
        feats = self.encoder(batch.video, audio, state)
        return self.timing_head(feats)`,
  'configs/ablation.yaml': `# 输入消融：每次去掉一种模态，看误触发率和延迟
base: configs/train.yaml
epochs: 20
window_sec: 8
drop:
  - audio
  - state
val:
  split: ovo-bench/val
  metrics: [f1, false_trigger, latency]`,
  'configs/train.yaml': `model:
  backbone: qwen2.5-vl-7b
  hidden: 3584
data:
  root: data/ego-timing
  window_sec: 8
epochs: 20
lr: 2.0e-5
val: ovo-bench/val`,
  'README.md': `# timing-model

时机模型的训练与输入消融。

## 运行

python src/train.py --config configs/train.yaml`,
  'requirements.txt': `torch==2.5.1
transformers==4.46.2
accelerate==1.1.1
decord==0.6.0
pyyaml==6.0.2
wandb==0.18.5`,
  'src/data.py': `from torch.utils.data import Dataset


class StreamDataset(Dataset):
    """按时间窗口切分第一视角视频，标签是“此刻要不要介入”。"""

    def __init__(self, cfg):
        self.items = load_index(cfg["root"], cfg["window_sec"])`,
};
const changes = [
  { path: 'src/model.py', s: 'M', add: 9, del: 2 },
  { path: 'configs/ablation.yaml', s: 'A', add: 11, del: 0 },
];
const diffs = {
  'src/model.py': [
    ['hunk', '', '', '@@ -38,9 +38,16 @@ class TimingModel(nn.Module):'],
    ['eq', 38, 38, '    def __init__(self, cfg, drop=None):'],
    ['eq', 39, 39, '        super().__init__()'],
    ['eq', 40, 40, '        self.encoder = StreamEncoder(cfg)'],
    ['del', 41, '', '        self.head = nn.Linear(cfg.hidden, 2)'],
    ['add', '', 41, '        # 时机头只判断要不要介入；响应头单独训练'],
    ['add', '', 42, '        self.timing_head = nn.Linear(cfg.hidden, 2)'],
    ['add', '', 43, '        self.drop = set(drop or [])'],
    ['eq', 42, 44, ''],
    ['eq', 43, 45, '    def forward(self, batch):'],
    ['del', 44, '', '        feats = self.encoder(batch.video, batch.audio, batch.state)'],
    ['add', '', 46, '        audio = None if "audio" in self.drop else batch.audio'],
    ['add', '', 47, '        state = None if "state" in self.drop else batch.state'],
    ['add', '', 48, '        feats = self.encoder(batch.video, audio, state)'],
    ['eq', 45, 49, '        return self.timing_head(feats)'],
  ],
};
const commits = [
  ['3f9c2e1', '加入音频分支开关', '你', '今天 10:05'],
  ['9a1b77d', '评测脚本支持 OVO-Bench', '李嘉', '昨天'],
  ['c02e4f8', '基线配置', '你', '11 月 10 日'],
  ['71d0a3b', '初始化 timing-model', '你', '11 月 6 日'],
];
const packages = [
  ['torch', '2.5.1', ''],
  ['transformers', '4.46.2', '4.47.0'],
  ['accelerate', '1.1.1', ''],
  ['decord', '0.6.0', ''],
  ['numpy', '1.26.4', '2.1.3'],
  ['pyyaml', '6.0.2', ''],
  ['wandb', '0.18.5', '0.18.7'],
  ['scikit-learn', '1.5.2', ''],
];
const manuscripts = [
  { id: 'survey', name: '主动式交互综述', files: ['main.tex', 'sections/method.tex', 'refs.bib'], updated: '今天' },
  { id: 'neurips', name: 'NeurIPS 投稿', files: ['main.tex', 'refs.bib'], updated: '11 月 9 日' },
];
const refs = [
  { key: 'yang2026proactive', paper: 'p1', cited: 3 },
  { key: 'lu2025proactive', paper: 'p2', cited: 2 },
  { key: 'chen2025proactivebench', paper: 'p3', cited: 1 },
  { key: 'li2025ovobench', paper: 'p4', cited: 2 },
  { key: 'zhang2024proagent', paper: 'p7', cited: 1 },
  { key: 'chen2024videollm', paper: 'p8', cited: 1 },
  { key: 'wang2024mmduet', title: 'VideoLLM Knows When to Speak: Enhancing Time-Sensitive Video Comprehension', year: 2024, cited: 1 },
  { key: 'qian2024streaming', title: 'Streaming Long Video Understanding with Large Language Models', year: 2024, cited: 1 },
];
const pending = [
  { icon: 'refresh', text: '<b>Foundation</b> 有 1 处同步冲突', meta: '实验设计.md · 本机版本已另存为副本', act: 'conflict' },
  { icon: 'flask', text: '运行 <b>baseline-r2</b> 失败：CUDA out of memory', meta: 'Proactive · 昨天 19:46', act: 'run' },
  { icon: 'shield', text: 'AI 请求新建笔记 <b>「ProAgent 方法拆解」</b>', meta: 'Proactive · 3 分钟前', act: 'approve' },
  { icon: 'userplus', text: '李嘉邀请你加入 <b>Embodied Eval</b>', meta: '查看者 · 今天 11:02', act: 'invite' },
];

/* ---------------- State ---------------- */
const state = {
  route: 'mine',
  history: ['mine'],
  cursor: 0,
  last: {},
  theme: 'graphite',
  sidebar: true,
  aux: null, // 'ai' | 'notes' | null
  shelf: 'books',
  mineFilter: 'all',
  folder: 'all',
  paper: 'p1',
  preview: true,
  tabs: [
    { kind: 'read', id: 'p1' },
    { kind: 'read', id: 'p2' },
    { kind: 'web', id: 'w1' },
  ],
  source: 'all',
  added: new Set(['s5']),
  noteFilter: 'all',
  note: 'n1',
  auxNote: 'n4',
  run: null,
  file: 'src/train.py',
  openFiles: ['src/train.py', 'configs/ablation.yaml'],
  terminal: true,
  gitFile: 'src/model.py',
  gitMsg: '',
  manuscript: 'survey',
  outline: false,
  zoom: 100,
  selection: false,
  highlighted: false,
  stepsOpen: false,
  approved: null,
  excerpts: 1,
  inviteDone: false,
  downloaded: false,
  palette: false,
  paletteIndex: 0,
  settings: null,
  pop: null,
  toast: null,
};
const parts = () => state.route.split('/');
const project = (id) => projects.find((p) => p.id === id);
const currentProject = () => (parts()[0] === 'p' ? project(parts()[1]) : null);
const base = () => `p/${parts()[1]}`;
const paperOf = (id) => papers.find((x) => x.id === id) || papers[0];
const expOf = (id) => experiments.find((e) => e.id === id) || experiments[0];
const moduleOf = (mod) => ({ lib: 'lib', subs: 'lib', read: 'lib', web: 'lib', notes: 'notes', exp: 'exp', write: 'write' })[mod];

/* ---------------- Navigation ---------------- */
function go(route, push = true) {
  state.pop = null;
  state.palette = false;
  // Entering a project returns to where the user left it; the first visit opens the library.
  if (/^p\/[^/]+$/.test(route)) route = `${route}/${state.last[route.slice(2)] || 'lib'}`;
  if (route === state.route) return render();
  state.route = route;
  if (push) {
    state.history = state.history.slice(0, state.cursor + 1).concat(route);
    state.cursor = state.history.length - 1;
  }
  const [kind, pid, mod, a] = parts();
  if (kind === 'p') state.last[pid] = parts().slice(2).join('/');
  if (mod === 'read') {
    if (!state.tabs.some((t) => t.kind === 'read' && t.id === a)) state.tabs.push({ kind: 'read', id: a });
    state.paper = a;
    if (!state.aux) state.aux = 'notes';
  }
  if (mod === 'notes' && state.aux === 'notes') state.aux = null;
  state.selection = false;
  location.hash = route;
  render();
}
function step(delta) {
  const next = state.cursor + delta;
  if (next < 0 || next >= state.history.length) return;
  state.cursor = next;
  go(state.history[next], false);
}
function toast(text, undo) {
  state.toast = { text, undo };
  render();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    state.toast = null;
    render();
  }, 3600);
}

/* ---------------- Small pieces ---------------- */
const cover = (p, cls = '') =>
  `<span class="cover ${cls}" style="--tone:${p.tone}"><span class="spine"></span>${p.field && !cls ? `<span class="cf">${esc(p.field)}</span>` : ''}<span class="ct"><b>${esc(p.name)}</b>${cls ? '' : `<small>${esc(p.question)}</small>`}</span></span>`;
const mini = (p) => `<span class="mini-cover" style="--tone:${p.tone}"></span>`;
const faces = (ms) => `<span class="faces">${ms.map((m) => `<span class="avatar">${m}</span>`).join('')}</span>`;
const dot = (cls, label = '') => `<span class="state ${cls}"><span class="d"></span>${label}</span>`;
function runState(r) {
  const map = { run: ['run', '运行中'], ok: ['ok', '完成'], bad: ['bad', '失败'], none: ['', '—'] };
  const [cls, label] = map[r.state || r.last];
  return dot(cls, label);
}
function statusCell(x) {
  if (x.status === 'read') return dot('ok', '已读');
  if (x.status === 'unread') return dot('', '未读');
  return `<span class="state" style="gap:8px"><span class="bar" style="width:44px"><i style="width:${x.progress}%"></i></span>${x.progress}%</span>`;
}
function inGroup(x, id) {
  if (id === 'all') return true;
  if (id === 'reading' || id === 'unread') return x.status === id;
  if (id === 'star') return x.star;
  return x.dir === id;
}
const groupName = (id) => groups.find((g) => g.id === id)?.name || id;
function pageHead(title, sub, actions = '', eyebrow = '') {
  return `<div class="ph"><div>${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}<h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div><div class="actions">${actions}</div></div>`;
}

/* ---------------- Shell ---------------- */
function crumbs() {
  const [kind, pid, mod, a, b] = parts();
  if (kind !== 'p') return `<span class="here">${{ mine: '我的项目', team: '团队项目' }[kind] || ''}</span>`;
  const p = project(pid);
  const m = moduleOf(mod);
  const items = [
    [esc(p.name), 'data-pop="switcher"'],
    [{ lib: '文献', notes: '笔记', exp: '实验', write: '写作' }[m], `data-go="p/${pid}/${m}"`],
  ];
  if (mod === 'lib') items.push([groupName(state.folder)]);
  if (mod === 'subs') items.push(['订阅']);
  if (mod === 'read') items.push([esc(paperOf(a).title)]);
  if (mod === 'web') items.push(['arxiv.org']);
  if (mod === 'notes') items.push([state.noteFilter === 'trash' ? '回收站' : esc(notes.find((n) => n.id === state.note)?.title || '')]);
  if (mod === 'exp' && a) items.push([expOf(a).name, `data-go="p/${pid}/exp/${a}/runs"`], [{ runs: '运行', code: '代码', git: '版本', env: '环境' }[b]]);
  if (mod === 'write') items.push([a === 'refs' ? '参考文献' : manuscripts.find((x) => x.id === state.manuscript).name]);
  return items
    .map(([t, attr], i) =>
      i === items.length - 1 ? `<span class="here">${t}</span>` : `<button ${attr}>${t}</button>`,
    )
    .join('<span class="sep">/</span>');
}

function titlebar() {
  const p = currentProject();
  const mod = parts()[2];
  const right = [];
  if (p) right.push(`<button class="ib share" data-pop="share">${p.team ? faces(p.members.slice(0, 3)) : icon('userplus')}<span class="lbl">共享</span></button>`, '<span class="tb-sep"></span>');
  right.push(`<button class="ib rel" data-pop="bell" title="通知">${icon('bell')}<span class="dot-badge"></span></button>`);
  if (p && mod !== 'notes')
    right.push(`<button class="ib" data-act="aux" data-tab="notes" aria-pressed="${state.aux === 'notes'}" title="笔记">${icon('note')}<span class="lbl">笔记</span></button>`);
  if (p) right.push(`<button class="ib" data-act="aux" data-tab="ai" aria-pressed="${state.aux === 'ai'}" title="AI 助手  Ctrl J">${icon('ai')}<span class="lbl">AI</span></button>`);
  return `<header class="titlebar">
    <div class="tb-left">
      <button class="brandmark" data-go="mine" title="回到项目中心"><img class="logo-light" src="${LOGO}scientify-light.png" alt=""><img class="logo-dark" src="${LOGO}scientify-dark.png" alt=""></button>
      <button class="ib" data-act="sidebar" title="侧边栏  Ctrl \\">${icon('sidebar')}</button>
      <button class="ib" data-act="back" title="后退  Alt ←" ${state.cursor ? '' : 'style="opacity:.4"'}>${icon('back')}</button>
      <button class="ib" data-act="fwd" title="前进  Alt →" ${state.cursor < state.history.length - 1 ? '' : 'style="opacity:.4"'}>${icon('fwd')}</button>
      <nav class="crumbs" aria-label="位置">${crumbs()}</nav>
    </div>
    <button class="searchbox" data-act="palette">${icon('search', 'i-sm')}<span>${p ? `在 ${esc(p.name)} 中搜索，或输入 > 执行命令` : '搜索项目、论文和笔记'}</span><kbd>Ctrl K</kbd></button>
    <div class="tb-right">${right.join('')}
      <div class="wc"><button title="最小化">${icon('minus', 'i-sm')}</button><button title="最大化">${icon('square', 'i-sm')}</button><button title="关闭">${icon('x', 'i-sm')}</button></div>
    </div>
  </header>`;
}

const sideFoot = () => `<div class="side-foot">
  <button class="account" data-pop="me"><span class="avatar">潘</span><span class="who"><b>潘子禾</b></span></button>
  <button class="ib" title="帮助与反馈">${icon('help')}</button>
  <button class="ib" data-act="settings" title="设置  Ctrl ,">${icon('settings')}</button>
</div>`;

function sidebar() {
  return parts()[0] === 'p' ? projectSidebar() : centerSidebar();
}

function centerSidebar() {
  const r = state.route;
  const item = (route, ic, label, extra = '') =>
    `<button class="nav-item" data-go="${route}" ${r === route ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${extra}</button>`;
  const mine = projects.filter((p) => !p.team && !p.archived).length;
  const team = projects.filter((p) => p.team && !p.archived).length;
  return `<aside class="sidebar" aria-label="项目中心">
    ${item('mine', 'folder', '我的项目', `<span class="count">${mine}</span>`)}
    ${item('team', 'users', '团队项目', `${state.inviteDone ? '' : '<span class="dot-new" title="有新邀请"></span>'}<span class="count">${team}</span>`)}
    ${sideFoot()}
  </aside>`;
}

function projectSidebar() {
  const p = currentProject();
  const [, pid, mod] = parts();
  const m = moduleOf(mod);
  const c = countsOf(pid);
  const nav = (key, ic, label, n) =>
    `<button class="nav-item modnav" data-go="p/${pid}/${key}" ${m === key ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span><span class="count">${n || ''}</span></button>`;
  return `<aside class="sidebar" aria-label="${esc(p.name)}">
    <button class="uplink" data-go="${p.team ? 'team' : 'mine'}">${icon('left', 'i-sm')}${p.team ? '团队项目' : '我的项目'}</button>
    <button class="switcher" data-pop="switcher" title="切换项目">${cover(p, 'xs')}<span class="who"><b>${esc(p.name)}</b><small>${p.team ? `团队 · ${p.role}` : '个人项目'}</small></span>${icon('updown', 'i-sm')}</button>
    ${nav('lib', 'book', '文献', c.papers)}
    ${nav('notes', 'note', '笔记', c.notes)}
    ${nav('exp', 'flask', '实验', c.exps)}
    ${nav('write', 'pen', '写作', c.ms)}
    <div class="side-ctx">${resources(m)}</div>
    ${sideFoot()}
  </aside>`;
}

/* The active module's own resources: what the old second rail and tree held. */
function resources(m) {
  const [, pid, mod, a, b] = parts();
  const cur = (cond) => (cond ? 'aria-current="page"' : '');
  if (m === 'lib') {
    const subs = mod === 'subs';
    const seg = `<div class="seg2 full"><button data-go="p/${pid}/lib" aria-pressed="${!subs}">文献库</button><button data-go="p/${pid}/subs" aria-pressed="${subs}">订阅</button></div>`;
    if (subs)
      return `${seg}
        <button class="nav-item" data-act="source" data-k="all" ${cur(state.source === 'all')}>${icon('inbox')}<span>新论文</span><span class="count">${feed.length - state.added.size}</span></button>
        <div class="nav-label"><span>订阅源</span><button title="新建订阅" data-act="newfeed">${icon('plus', 'i-sm')}</button></div>
        ${sources.map((s) => `<button class="nav-item" data-act="source" data-k="${s.id}" ${cur(state.source === s.id)}>${icon('rss')}<span>${s.name}</span><span class="count">${feed.filter((x) => x.src === s.id).length}</span></button>`).join('')}
        <div class="nav-label"><span>网站</span><button title="添加网站">${icon('plus', 'i-sm')}</button></div>
        ${sites.map((s) => `<button class="nav-item" data-go="p/${pid}/web/w1">${icon('globe')}<span>${s}</span>${icon('ext', 'i-sm trail')}</button>`).join('')}`;
    const g = (x) =>
      `<button class="nav-item" data-act="folder" data-k="${x.id}" ${cur(mod === 'lib' && state.folder === x.id)}>${icon(x.icon)}<span>${x.name}</span><span class="count">${papers.filter((y) => inGroup(y, x.id)).length}</span></button>`;
    return `${seg}${groups.map(g).join('')}
      <div class="nav-label"><span>文件夹</span><button title="新建文件夹" data-act="newfolder">${icon('plus', 'i-sm')}</button></div>
      ${dirs.map((d) => `<button class="nav-item" data-act="folder" data-k="${d}" ${cur(mod === 'lib' && state.folder === d)} data-ctx="folder">${icon('folder')}<span>${d}</span><span class="count">${papers.filter((y) => y.dir === d).length}</span></button>`).join('')}`;
  }
  if (m === 'notes') {
    const f = (k, ic, label, n) =>
      `<button class="nav-item" data-act="nfilter" data-k="${k}" ${cur(state.noteFilter === k)}>${icon(ic)}<span>${label}</span><span class="count">${n}</span></button>`;
    return `<div class="nav-label first"><span>笔记</span><button title="新建笔记" data-act="newnote">${icon('plus', 'i-sm')}</button></div>
      ${f('all', 'note', '全部笔记', notes.length)}
      ${f('paper', 'book', '论文笔记', notes.filter((n) => n.sources).length)}
      <div class="nav-label"><span>标签</span></div>
      ${noteTags.map((t) => f(`tag:${t}`, 'tag', t, notes.filter((n) => n.tags.includes(t)).length)).join('')}
      <div class="nav-label"><span></span></div>
      ${f('trash', 'trash', '回收站', trashed.length)}`;
  }
  if (m === 'exp') {
    const tab = mod === 'exp' && b ? b : 'runs';
    return `<div class="nav-label first"><span>实验</span><button title="新建实验" data-act="newexp">${icon('plus', 'i-sm')}</button></div>
      <button class="nav-item" data-go="p/${pid}/exp" ${cur(!a)}>${icon('grid')}<span>全部实验</span><span class="count">${experiments.length}</span></button>
      ${experiments.map((e) => `<button class="nav-item" data-go="p/${pid}/exp/${e.id}/${tab}" ${cur(a === e.id)} data-ctx="exp" data-id="${e.id}">${icon('flask')}<span>${e.name}</span>${e.last === 'run' ? `<span class="tail">${dot('run')}</span>` : e.last === 'bad' ? `<span class="tail">${dot('bad')}</span>` : ''}</button>`).join('')}`;
  }
  return `<div class="nav-label first"><span>稿件</span><button title="新建稿件" data-act="newms">${icon('plus', 'i-sm')}</button></div>
    ${manuscripts.map((x) => `<button class="nav-item" data-act="ms" data-k="${x.id}" ${cur(a !== 'refs' && state.manuscript === x.id)}>${icon('file')}<span>${x.name}</span><span class="count">${x.updated}</span></button>`).join('')}
    <div class="nav-label"><span>引用</span></div>
    <button class="nav-item" data-go="p/${pid}/write/refs" ${cur(a === 'refs')}>${icon('quote')}<span>参考文献</span><span class="count">${refs.length}</span></button>`;
}

/* ---------------- Project center ---------------- */
function minePage() {
  const f = state.mineFilter;
  const list = projects.filter((p) =>
    !p.team && (f === 'archived' ? p.archived : !p.archived),
  );
  const seg = [
    ['all', '进行中'],
    ['archived', '已归档'],
  ]
    .map(([k, l]) => `<button data-act="mfilter" data-k="${k}" aria-pressed="${f === k}">${l}</button>`)
    .join('');
  const books = `<div class="shelf">${list
    .map(
      (p) => `<div class="book" data-go="p/${p.id}" data-ctx="project" data-id="${p.id}" tabindex="0">
        ${cover(p)}
        <div class="bmeta"><span>${p.opened}</span><button class="ib more" data-act="ctx" data-ctx="project" data-id="${p.id}" title="更多">${icon('more')}</button></div>
      </div>`,
    )
    .join('')}${f === 'all' ? `<button class="book new" data-act="newproject"><span class="cover ghost">${icon('plus')}<span>新建项目</span></span></button>` : ''}</div>`;
  const table = `<table class="ptable"><thead><tr><th>项目</th><th>论文</th><th>笔记</th><th>实验</th><th>最近打开</th><th></th></tr></thead><tbody>${list
    .map(
      (p) => `<tr data-go="p/${p.id}" data-ctx="project" data-id="${p.id}">
      <td><div class="pname">${cover(p, 'xs')}<div class="t"><b>${esc(p.name)}</b></div></div></td>
      <td class="num meta">${countsOf(p.id).papers}</td><td class="num meta">${countsOf(p.id).notes}</td><td class="num meta">${countsOf(p.id).exps}</td>
      <td class="meta">${p.opened}</td>
      <td><button class="ib" data-act="ctx" data-ctx="project" data-id="${p.id}">${icon('more')}</button></td></tr>`,
    )
    .join('')}</tbody></table>`;
  const away =
    f === 'all' && !state.downloaded
      ? `<div class="section"><h2>在其他设备上 <small>${elsewhere.length}</small></h2><div class="rows">${elsewhere
          .map(
            (x) => `<div class="row">${cover(x, 'xs')}<div class="t"><b>${esc(x.name)}</b><small>最后在 ${x.device} 上打开 · ${x.at}</small></div><button class="btn secondary sm" data-act="download">${icon('download', 'i-sm')}下载到这台电脑</button></div>`,
          )
          .join('')}</div></div>`
      : '';
  return `<div class="page"><div class="page-inner">
    ${pageHead('我的项目', '', `<button class="btn primary" data-act="newproject">${icon('plus')}新建项目</button>`)}
    <div class="toolbar"><div class="seg2">${seg}</div><span style="flex:1"></span>
      <label class="field sm">${icon('search', 'i-sm')}<input placeholder="筛选项目"></label>
      <button class="chip">${icon('sort', 'i-sm')}最近打开</button>
      <div class="seg2"><button data-act="shelf" data-k="books" aria-pressed="${state.shelf === 'books'}" title="书架">${icon('grid', 'i-sm')}</button><button data-act="shelf" data-k="list" aria-pressed="${state.shelf === 'list'}" title="列表">${icon('list', 'i-sm')}</button></div>
    </div>
    ${list.length ? (state.shelf === 'books' ? books : table) : '<div class="empty" style="height:240px">没有已归档的项目</div>'}
    ${away}
  </div></div>`;
}

function teamPage() {
  const list = projects.filter((p) => p.team && !p.archived);
  const inv = state.inviteDone
    ? ''
    : `<div class="section first"><h2>新邀请 <small>${invites.length}</small></h2><div class="rows">${invites
        .map(
          (x) => `<div class="row">${cover(x, 'xs')}<div class="t"><span class="line"><b>${people[x.from]}</b> 邀请你加入 <b>${esc(x.name)}</b></span><small>${x.role} · ${x.members.length} 位成员 · ${x.at}</small></div><button class="btn ghost sm" data-act="ignoreinvite">忽略</button><button class="btn primary sm" data-act="accept">${icon('download', 'i-sm')}下载并打开</button></div>`,
        )
        .join('')}</div></div>`;
  return `<div class="page"><div class="page-inner">
    ${pageHead('团队项目', '', `<button class="btn secondary" data-act="sharelocal">${icon('users')}共享本机项目</button><button class="btn primary" data-act="newteam">${icon('plus')}新建团队项目</button>`)}
    ${inv}
    <div class="section ${inv ? '' : 'first'}"><h2>我参与的 <small>${list.length}</small></h2>
      <table class="ptable"><thead><tr><th>项目</th><th>所有者</th><th>我的角色</th><th>成员</th><th>最近更新</th><th></th></tr></thead><tbody>${list
        .map(
          (p) => `<tr data-go="p/${p.id}" data-ctx="project" data-id="${p.id}">
          <td><div class="pname">${cover(p, 'xs')}<div class="t"><b>${esc(p.name)}</b></div></div></td>
          <td class="meta">${people[p.owner]}</td><td class="meta">${p.role}</td>
          <td><button class="ib facebtn" data-pop="share" data-id="${p.id}">${faces(p.members)}</button></td>
          <td class="meta">${p.opened}</td>
          <td><button class="ib" data-act="ctx" data-ctx="project" data-id="${p.id}">${icon('more')}</button></td></tr>`,
        )
        .join('')}</tbody></table>
    </div>
  </div></div>`;
}

/* ---------------- Literature ---------------- */
function tabstrip() {
  const [, pid, mod, a] = parts();
  if (!state.tabs.length && mod !== 'web') return '';
  const t = (x) => {
    const on = mod === x.kind && a === x.id;
    const label = x.kind === 'read' ? paperOf(x.id).short : 'arXiv · 2511.08812';
    return `<div class="ftab ${on ? 'on' : ''}" data-go="p/${pid}/${x.kind}/${x.id}" title="${esc(x.kind === 'read' ? paperOf(x.id).title : 'arxiv.org/abs/2511.08812')}">${icon(x.kind === 'read' ? 'file' : 'globe', 'i-sm')}<span>${esc(label)}</span><button class="x" data-act="closetab" data-k="${x.kind}" data-id="${x.id}" title="关闭">${icon('x', 'i-sm')}</button></div>`;
  };
  const home = mod === 'subs' ? '订阅' : '文献库';
  return `<div class="tabstrip">
    <button class="ftab home ${mod === 'lib' || mod === 'subs' ? 'on' : ''}" data-go="p/${pid}/${mod === 'subs' ? 'subs' : 'lib'}">${icon(mod === 'subs' ? 'rss' : 'book', 'i-sm')}<span>${home}</span></button>
    <span class="tsep"></span>${state.tabs.map(t).join('')}
    <button class="ib newtab" data-act="newtab" title="新建浏览器标签">${icon('plus', 'i-sm')}</button>
  </div>`;
}

function libPage() {
  const pid = parts()[1];
  const list = papers.filter((x) => inGroup(x, state.folder));
  const sel = list.find((x) => x.id === state.paper) || list[0];
  const showPreview = state.preview && !state.aux && sel;
  return `<div class="mod">${tabstrip()}
    <div class="lib ${showPreview ? '' : 'no-preview'}">
      <div class="listpane">
        <div class="listhead">
          ${pageHead(groupName(state.folder), '', `<button class="btn secondary" data-act="openai">${icon('ai')}问这些论文</button><button class="btn primary" data-pop="import">${icon('upload')}导入${icon('down', 'i-sm')}</button>`)}
          <div class="toolbar">
            <label class="field">${icon('search', 'i-sm')}<input placeholder="标题、作者、标签"></label>
            <button class="chip">${icon('filter', 'i-sm')}状态</button><button class="chip">年份</button><button class="chip">标签</button>
            <span style="flex:1"></span><button class="chip">${icon('sort', 'i-sm')}最近添加</button>
          </div>
        </div>
        <div class="table" role="grid" aria-label="论文">
          <div class="trow th"><span>标题</span><span>年份</span><span>来源</span><span>阅读</span><span>笔记</span><span>添加</span></div>
          ${list
            .map(
              (x) => `<div class="trow ${x.id === sel?.id ? 'sel' : ''}" data-act="pick" data-id="${x.id}" data-ctx="paper" tabindex="-1">
              <div class="t"><b>${x.star ? '<span class="star">★</span>' : ''}${esc(x.title)}</b><small>${esc(x.authors)}</small></div>
              <span class="c">${x.year}</span><span class="c">${x.venue}</span><span>${statusCell(x)}</span><span class="c">${x.notes || ''}</span><span class="c">${x.added}</span></div>`,
            )
            .join('')}
        </div>
      </div>
      ${
        showPreview
          ? `<aside class="preview" aria-label="论文信息">
        <div class="meta">${sel.venue} ${sel.year}</div>
        <h3>${esc(sel.title)}</h3>
        <div class="meta">${esc(sel.authors)}</div>
        <div class="pv-acts">
          <button class="btn primary" data-go="p/${pid}/read/${sel.id}">${icon('book')}${sel.status === 'unread' ? '开始阅读' : `继续读 · 第 ${sel.page} 页`}</button>
          <button class="btn secondary" data-act="openai">${icon('ai')}问 AI</button>
          <button class="ib" data-act="ctx" data-ctx="paper" data-id="${sel.id}">${icon('more')}</button>
        </div>
        <dl class="kv"><dt>阅读</dt><dd>${statusCell(sel)}</dd><dt>文件夹</dt><dd>${sel.dir}</dd><dt>标签</dt><dd>${sel.tags.map((t) => `<span class="tag">${t}</span>`).join('')}</dd><dt>笔记</dt><dd>${sel.notes ? `${sel.notes} 条` : '还没有'}</dd><dt>文件</dt><dd class="ell">${esc(sel.short)}.pdf</dd></dl>
        <div class="section" style="margin-top:8px"><h2>摘要</h2>
        <p class="abstract">Physical AI is commonly formulated around an explicitly specified task: given a goal or instruction, a system perceives, reasons, and acts. In many real-world settings, however, important tasks emerge from continuously changing world states before a person explicitly formulates them…</p></div>
      </aside>`
          : ''
      }
    </div></div>`;
}

function readPage() {
  const x = paperOf(parts()[3]);
  const outline = [
    ['Abstract', 1],
    ['1 Introduction', 1],
    ['2 Related Work', 3],
    ['3 Proactive Physical AI', 4],
    ['3.1 Timing Model', 5],
    ['3.2 Response Model', 6],
    ['4 Data Pipeline', 7],
    ['5 Experiments', 9],
    ['5.1 Explicit Objectives', 10],
    ['5.2 Standing Policies', 11],
    ['5.3 Real-Robot Evaluation', 12],
    ['6 Conclusion', 14],
  ];
  const s = 'A response decision enables output generation, not the ingestion of new observations.';
  const sentence = `<span data-act="select" style="cursor:text">${
    state.highlighted ? `<mark class="hl">${s}</mark>` : state.selection ? `<mark class="sel">${s}</mark>` : s
  }</span>`;
  return `<div class="mod">${tabstrip()}<div class="reader">
    <div class="rbar">
      <button class="ib" data-act="outline" aria-pressed="${state.outline}" title="目录">${icon('toc')}</button>
      <span class="pager"><input value="${x.page}" aria-label="页码">/ ${x.pages}</span>
      <span class="vline"></span>
      <button class="ib" data-act="zoom" data-d="-10" title="缩小">${icon('zout')}</button>
      <span class="meta num" style="width:38px;text-align:center">${state.zoom}%</span>
      <button class="ib" data-act="zoom" data-d="10" title="放大">${icon('zin')}</button>
      <span style="flex:1"></span>
      <button class="ib" title="高亮">${icon('mark')}</button>
      <button class="ib" title="在论文中查找  Ctrl F">${icon('search')}</button>
      <button class="ib" title="专注阅读">${icon('max')}</button>
      <button class="ib" data-act="ctx" data-ctx="paper" data-id="${x.id}" title="更多">${icon('more')}</button>
    </div>
    <div class="rbody ${state.outline ? 'with-outline' : ''}">
      <nav class="outline" aria-label="目录">${state.outline ? outline.map(([t, pg], i) => `<button class="nav-item" ${i === 10 ? 'aria-current="page"' : ''} style="padding-left:${/^\d+\.\d/.test(t) ? 22 : 8}px"><span>${t}</span><small>${pg}</small></button>`).join('') : ''}</nav>
      <div class="desk" data-act="deselect">
        <article class="sheet" style="font-size:${(14.5 * state.zoom) / 100}px">
          <div class="kicker">Research Paper · arXiv 2026</div>
          <h1>Proactive Physical AI through Continuous Observation and Timely Intervention</h1>
          <div class="authors">Zhenhua Yang, Jiafeng Liang, Xingyu Zhou, Yi Jiang, Xiayu Cao, Zui Chen, Luqi Wang, Haiyang Sun · Harbin Institute of Technology</div>
          <div class="abs"><b>Abstract.</b> Physical AI is commonly formulated around an explicitly specified task. In many real-world settings, however, important tasks emerge from continuously changing world states before a person explicitly formulates them. We develop ProAgent, an end-to-end system built around two components: a proactive timing model that determines whether and when intervention is needed, and a Response Model that generates responses for people or invokes device capabilities.</div>
          <h2>3.2 Response Model</h2>
          <p>Both models consume the causal world stream asynchronously; the Response Model can accumulate context while the Timing Model remains silent. ${sentence} Experiments demonstrate strong proactive timing performance under both explicit objectives and standing policies, with fewer false triggers than the source-backbone baseline.</p>
          <div class="fig">Figure 1 · ProAgent architecture</div>
          <div class="cap"><b>Figure 1.</b> ProAgent architecture. Both models consume the causal world stream asynchronously.</div>
          <p style="margin-top:12px">To support learning at scale, we develop an automated data pipeline that converts videos into supervision for proactive timing. Real-robot evaluations further demonstrate ProAgent's ability to identify emerging needs and translate them into appropriate physical actions.</p>
          ${
            state.selection && !state.highlighted
              ? `<div class="selpop" style="visibility:hidden">
              <button data-act="hl"><span class="sw"></span>高亮</button>
              <button data-act="excerpt">${icon('quote', 'i-sm')}摘录到笔记</button>
              <button data-act="askselection">${icon('ai', 'i-sm')}问 AI</button>
              <button data-act="translate">${icon('translate', 'i-sm')}翻译</button>
              <button data-act="copycite">${icon('copy', 'i-sm')}复制引用</button></div>`
              : ''
          }
          <div class="pn">${x.page}</div>
        </article>
      </div>
    </div>
  </div></div>`;
}

function webPage() {
  return `<div class="mod">${tabstrip()}<div class="web">
    <div class="rbar">
      <button class="ib" title="后退">${icon('left')}</button><button class="ib" title="前进">${icon('right')}</button><button class="ib" title="刷新">${icon('refresh')}</button>
      <label class="addr">${icon('globe', 'i-sm')}<input value="arxiv.org/abs/2511.08812"></label>
      <button class="btn primary sm" data-act="savepdf">${icon('download', 'i-sm')}存入文献库</button>
      <button class="ib" title="在系统浏览器中打开">${icon('ext')}</button>
    </div>
    <div class="webview"><div class="site">
      <div class="site-bar">arXiv &gt; cs &gt; arXiv:2511.08812</div>
      <h1>When to Speak: Learning Intervention Timing for Always-On Assistants</h1>
      <div class="site-auth">Kai Liu, Mengyu Xu, Jiawei Sun, Hao Zhang</div>
      <p><b>Abstract:</b> Always-on assistants observe users continuously but must decide when an intervention is worth the interruption. We frame timing as cost-sensitive detection over a causal stream and learn it from weakly labeled egocentric video…</p>
      <div class="site-links"><span>View PDF</span><span>HTML (experimental)</span><span>TeX Source</span></div>
    </div></div>
  </div></div>`;
}

function subsPage() {
  const list = feed.filter((x) => state.source === 'all' || x.src === state.source);
  const by = ['今天', '昨天', '本周'];
  const title = state.source === 'all' ? '新论文' : sources.find((s) => s.id === state.source).name;
  return `<div class="mod">${tabstrip()}<div class="listpane">
    <div class="listhead">${pageHead(title, '', `<button class="btn secondary" data-act="feeds">管理订阅</button><button class="btn primary" data-act="newfeed">${icon('plus')}新建订阅</button>`)}
      <div class="toolbar"><label class="field">${icon('search', 'i-sm')}<input placeholder="在新论文里搜索"></label><span style="flex:1"></span><button class="chip">全部标为已看</button></div></div>
    <div class="table">${by
      .map((w) => {
        const items = list.filter((x) => x.when === w);
        return items.length
          ? `<div class="sgroup">${w}</div>${items
              .map((x) => {
                const done = state.added.has(x.id);
                return `<div class="srow" data-ctx="sub" data-id="${x.id}">
                <div class="t"><b>${esc(x.title)}</b><small>${esc(x.authors)} · ${x.venue}</small></div>
                <span class="sfeed">${sources.find((s) => s.id === x.src).name}</span>
                <span class="acts ${done ? 'done' : ''}">${done ? dot('ok', '已在文献库') : `<button class="btn ghost sm" data-go="p/${parts()[1]}/web/w1">预览</button><button class="btn secondary sm" data-act="addsub" data-id="${x.id}">${icon('plus', 'i-sm')}存入文献库</button>`}</span></div>`;
              })
              .join('')}`
          : '';
      })
      .join('')}</div>
  </div></div>`;
}

/* ---------------- Notes ---------------- */
function notesPage() {
  const pid = parts()[1];
  const f = state.noteFilter;
  if (f === 'trash') return trashPage();
  const list = notes.filter((n) => (f === 'all' ? true : f === 'paper' ? n.sources : n.tags.includes(f.slice(4))));
  const n = list.find((x) => x.id === state.note) || list[0];
  const title = f === 'all' ? '全部笔记' : f === 'paper' ? '论文笔记' : f.slice(4);
  const body =
    n.id === 'n1'
      ? `<p>两个模型共享同一条持续的观察流，但职责完全不同：</p>
          <ul><li><b>决策模型</b>回答“要不要介入、何时介入”。它大部分时间保持静默。</li><li><b>响应模型</b>回答“对谁说、说什么、做什么”，可以生成回复，也可以调用设备能力。</li></ul>
          <blockquote>A response decision enables output generation, not the ingestion of new observations. <span class="cite" data-go="p/${pid}/read/p1">p.4</span></blockquote>
          <h2>和我们的方案的差别</h2>
          <p>我们目前把时机判断和回复生成放在同一个模型里，误触发率偏高。拆开之后，时机模型可以用更便宜的骨干，响应模型只在被触发时运行。</p>
          <h2>待验证</h2>
          <ul><li>时机标签来自自动管线，噪声有多大？</li><li>在 OVO-Bench 上能否复现“误触发更少”？见运行 <span class="cite" data-go="p/${pid}/exp/timing/runs" data-run="r5">timing-abl-03</span></li></ul>`
      : `<p>${esc(n.excerpt)}</p><p>（示意内容）</p>`;
  return `<div class="notes">
    <div class="nlist">
      <div class="head"><h2>${title}</h2><button class="ib" title="搜索笔记">${icon('search')}</button><button class="ib" data-act="newnote" title="新建笔记  Ctrl Shift N">${icon('plus')}</button></div>
      <div class="scroll">${['今天', '昨天', '本周', '更早']
        .map((g) => {
          const items = list.filter((x) => x.when === g);
          return items.length
            ? `<div class="ngroup">${g}</div>${items.map((x) => `<button class="nitem ${x.id === n.id ? 'sel' : ''}" data-act="note" data-id="${x.id}" data-ctx="note"><b>${esc(x.title)}</b><span>${esc(x.excerpt)}</span></button>`).join('')}`
            : '';
        })
        .join('')}</div>
    </div>
    <div class="doc">
      <div class="doc-bar"><span>${n.time}编辑 · 已保存</span><span style="flex:1"></span>
        <button class="ib" data-act="openai" title="让 AI 处理这篇笔记">${icon('ai')}</button>
        <button class="ib" data-act="ctx" data-ctx="note" data-id="${n.id}">${icon('more')}</button></div>
      <div class="doc-inner">
        <h1>${esc(n.title)}</h1>
        <dl class="props"><dt>来源</dt><dd>${n.sources ? `<span class="cite" data-go="p/${pid}/read/p1">${icon('book', 'i-sm')}Proactive Physical AI · p.4</span> <span class="cite" data-go="p/${pid}/read/p2">${icon('book', 'i-sm')}Proactive Agent · p.6</span>` : '<span class="meta">没有</span>'}</dd>
          <dt>标签</dt><dd>${n.tags.map((t) => `<span class="tag">${t}</span>`).join('')}<span class="tag add">＋ 添加</span></dd></dl>
        <div class="prose">${body}</div>
        ${n.id === 'n1' ? `<div class="backlinks"><div class="meta" style="margin-bottom:8px">引用这篇笔记</div><div class="rows"><div class="row" data-act="note" data-id="n4"><span class="glyph">${icon('note', 'i-sm')}</span><div class="t"><b>实验设计草稿：时机模型消融</b><small>“……分工的依据见「决策模型与响应模型的分工」……”</small></div></div></div></div>` : ''}
      </div>
    </div>
  </div>`;
}

function trashPage() {
  const t = trashed.find((x) => x.id === state.note) || trashed[0];
  return `<div class="notes">
    <div class="nlist">
      <div class="head"><h2>回收站</h2></div>
      <div class="scroll">${trashed.map((x) => `<button class="nitem ${x.id === t.id ? 'sel' : ''}" data-act="note" data-id="${x.id}"><b>${esc(x.title)}</b><span>${x.time}</span></button>`).join('')}</div>
      <div class="foot meta">30 天后自动清除</div>
    </div>
    <div class="doc">
      <div class="doc-bar"><span>${t.time}</span><span style="flex:1"></span><button class="btn ghost sm danger-text" data-act="purge">永久删除</button><button class="btn secondary sm" data-act="restore">恢复</button></div>
      <div class="doc-inner faded"><h1>${esc(t.title)}</h1><div class="prose"><p>${esc(t.excerpt) || '（空笔记）'}</p></div></div>
    </div>
  </div>`;
}

/* ---------------- Experiments ---------------- */
function expPage() {
  const [, pid, , a, b] = parts();
  if (!a) return expList(pid);
  const e = expOf(a);
  const tab = b || 'runs';
  const n = runs.filter((r) => r.exp === e.id).length;
  const tabs = [
    ['runs', '运行', n],
    ['code', '代码', ''],
    ['git', '版本', e.id === 'timing' ? changes.length : ''],
    ['env', '环境', ''],
  ];
  const body = { runs: runsTab, code: codeTab, git: gitTab, env: envTab }[tab](e);
  return `<div class="expd">
    <div class="mhead"><div><h1>${e.name}</h1><p class="sub"><span>${e.desc}</span></p></div>
      <div class="actions"><button class="btn ghost" data-act="terminal">${icon('terminal')}终端</button>
        <span class="splitbtn"><button class="btn primary" data-act="newrun">${icon('play')}运行</button><button class="btn primary caret" data-pop="runcfg" title="运行配置">${icon('down', 'i-sm')}</button></span></div></div>
    <div class="tabs">${tabs.map(([k, l, c]) => `<button data-go="p/${pid}/exp/${e.id}/${k}" aria-selected="${tab === k}">${l}${c ? `<span class="n">${c}</span>` : ''}</button>`).join('')}</div>
    ${body}
  </div>`;
}

function expList(pid) {
  return `<div class="page"><div class="page-inner">
    ${pageHead('全部实验', '', `<button class="btn primary" data-act="newexp">${icon('plus')}新建实验</button>`)}
    <div class="toolbar"><label class="field">${icon('search', 'i-sm')}<input placeholder="搜索实验"></label><span style="flex:1"></span><button class="chip">${icon('archive', 'i-sm')}显示已归档</button></div>
    <table class="ptable"><thead><tr><th>实验</th><th>代码</th><th>环境</th><th>最近运行</th><th>更新</th><th></th></tr></thead><tbody>${experiments
      .map(
        (e) => `<tr data-go="p/${pid}/exp/${e.id}/runs" data-ctx="exp" data-id="${e.id}">
        <td><div class="pname"><span class="glyph">${icon('flask', 'i-sm')}</span><div class="t"><b>${e.name}</b><small>${e.desc}</small></div></div></td>
        <td class="meta ell">${esc(e.code)}</td><td class="meta">${e.py}</td>
        <td><span class="state ${e.last === 'run' ? 'run' : e.last === 'bad' ? 'bad' : ''}"><span class="d"></span>${e.lastText}</span></td>
        <td class="meta">${e.updated}</td>
        <td><button class="ib" data-act="ctx" data-ctx="exp" data-id="${e.id}">${icon('more')}</button></td></tr>`,
      )
      .join('')}</tbody></table>
  </div></div>`;
}

function runsTab(e) {
  const list = runs.filter((r) => r.exp === e.id);
  if (!list.length)
    return `<div class="empty"><div style="text-align:center"><p>还没有运行</p><button class="btn secondary sm" data-go="p/${parts()[1]}/exp/${e.id}/env">先配置 Python</button></div></div>`;
  const sel = list.find((r) => r.id === state.run);
  const detail = sel
    ? `<aside class="rdetail" aria-label="运行详情">
      <div style="display:flex;align-items:center;gap:8px">${runState(sel)}<span style="flex:1"></span>${sel.state === 'run' ? `<button class="btn secondary sm">${icon('stop', 'i-sm')}停止</button>` : `<button class="btn secondary sm">${icon('refresh', 'i-sm')}重新运行</button>`}<button class="ib" data-act="closerun">${icon('x')}</button></div>
      <h3 style="margin:10px 0 2px;font-size:17px">${sel.name}</h3><div class="meta">${sel.cfg} · ${sel.started}</div>
      ${
        sel.state === 'bad'
          ? `<div class="section" style="margin-top:18px"><h2>出错位置</h2><div class="log">train.py:142  forward()
torch.cuda.OutOfMemoryError: CUDA out of memory.
Tried to allocate 2.00 GiB (GPU 0; 23.6 GiB total; 21.9 GiB in use)</div>
          <div style="display:flex;gap:6px;margin-top:10px"><button class="btn secondary sm" data-act="openai">${icon('ai', 'i-sm')}让 AI 看看</button><button class="btn ghost sm">打开日志</button></div></div>`
          : `<div class="chart"><div class="meta">验证集 F1</div><svg viewBox="0 0 300 110" preserveAspectRatio="none"><polyline fill="none" stroke="var(--line-strong)" stroke-width="1" points="0,100 300,100"/><polyline fill="none" stroke="var(--text)" stroke-width="1.6" points="0,92 30,80 60,66 90,58 120,50 150,44 180,40 210,37 240,35 270,34 300,33"/><polyline fill="none" stroke="var(--text-4)" stroke-width="1.2" stroke-dasharray="3 3" points="0,95 30,86 60,76 90,70 120,64 150,60 180,58 210,57 240,56 270,55 300,55"/></svg><div class="meta" style="display:flex;gap:14px"><span>— ${sel.name}</span><span style="color:var(--text-4)">- - timing-abl-01</span></div></div>
          <dl class="kv"><dt>F1</dt><dd class="num">${sel.f1}</dd><dt>延迟</dt><dd class="num">${sel.lat === '—' ? '—' : `${sel.lat} ms`}</dd><dt>代码</dt><dd>${icon('branch', 'i-sm')} main · 3f9c2e1</dd><dt>环境</dt><dd>${e.py} · torch 2.5</dd></dl>
          <div class="section" style="margin-top:14px"><h2>产物</h2><div class="rows"><div class="row"><span class="glyph">${icon('file', 'i-sm')}</span><div class="t"><b>metrics.json</b><small>2 KB</small></div></div><div class="row"><span class="glyph">${icon('chart', 'i-sm')}</span><div class="t"><b>confusion.png</b><small>84 KB</small></div></div></div></div>
          <div style="display:flex;gap:6px;margin-top:14px"><button class="btn secondary sm" data-act="runnote">${icon('note', 'i-sm')}写进笔记</button><button class="btn ghost sm">与其他运行对比</button></div>`
      }
    </aside>`
    : '';
  return `<div class="exp ${sel ? 'detail' : ''}">
    <div class="table">
      <div class="rtrow th"><span>状态</span><span>运行</span><span>开始</span><span>时长</span><span style="text-align:right">F1</span><span style="text-align:right">延迟 ms</span></div>
      ${list
        .map(
          (r) => `<div class="rtrow ${sel && sel.id === r.id ? 'sel' : ''}" data-act="run" data-id="${r.id}" data-ctx="run">
          ${runState(r)}<div class="t"><b>${r.name}</b><small>${r.note || r.cfg}</small></div>
          <span class="meta">${r.started}</span><span class="meta num">${r.dur}</span><span class="m ${r.best ? 'best' : ''}">${r.f1}</span><span class="m">${r.lat}</span></div>`,
        )
        .join('')}
    </div>
    ${detail}
  </div>`;
}

const PY = /(#.*$)|("[^"]*"|'[^']*')|\b(def|return|for|in|if|else|elif|import|from|as|with|not|None|True|False|and|or|class|lambda)\b|\b(\d+(?:\.\d+)?)\b/g;
function hl(line) {
  let out = '';
  let last = 0;
  PY.lastIndex = 0;
  for (let m = PY.exec(line); m; m = PY.exec(line)) {
    out += esc(line.slice(last, m.index));
    const cls = m[1] ? 'c-cm' : m[2] ? 'c-str' : m[3] ? 'c-kw' : 'c-num';
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(line.slice(last));
}

function codeTab() {
  const name = (path) => path.split('/').pop();
  const plain = /\.(md|txt)$/.test(state.file);
  const lines = (files[state.file] || '').split('\n');
  return `<div class="code">
    <nav class="ctree" aria-label="文件">
      <div class="ctree-head"><span>timing-model</span><button class="ib" title="新建文件">${icon('plus', 'i-sm')}</button><button class="ib" title="在工作区中搜索">${icon('search', 'i-sm')}</button></div>
      ${tree
        .map((n) =>
          n.dir
            ? `<div class="titem dir" style="padding-left:${6 + n.depth * 14}px">${icon(n.closed ? 'right' : 'down', 'i-sm')}<span>${n.dir}</span></div>`
            : `<button class="titem ${state.file === n.path ? 'on' : ''}" data-act="file" data-k="${n.path}" style="padding-left:${24 + n.depth * 14}px"><span>${name(n.path)}</span>${n.git ? `<span class="gs ${n.git}">${n.git}</span>` : ''}</button>`,
        )
        .join('')}
    </nav>
    <div class="cpane">
      <div class="etabs">${state.openFiles
        .map((f) => `<div class="etab ${state.file === f ? 'on' : ''}" data-act="file" data-k="${f}"><span>${name(f)}</span><button class="x" data-act="closefile" data-k="${f}">${icon('x', 'i-sm')}</button></div>`)
        .join('')}<span style="flex:1"></span><span class="meta">${state.file}</span>
        <button class="ib" data-act="openai" title="问 AI 这段代码">${icon('ai')}</button><button class="ib" title="在 VS Code 中打开">${icon('ext')}</button></div>
      <div class="lines">${lines
        .map((l, i) => `<div class="ln ${state.file === 'src/train.py' && i === 16 ? 'cur' : ''}"><i>${i + 1}</i><span>${plain ? esc(l) : hl(l)}</span></div>`)
        .join('')}</div>
      ${
        state.terminal
          ? `<div class="term">
        <div class="th"><button class="ttab on">终端</button><button class="ttab">输出</button><button class="ttab">产物</button><span class="meta">timing-model · venv</span><span style="flex:1"></span><button class="ib" title="新终端">${icon('plus', 'i-sm')}</button><button class="ib" data-act="terminal" title="收起">${icon('down', 'i-sm')}</button></div>
<pre>(venv) timing-model&gt; python src/train.py --config configs/ablation.yaml --drop audio
[epoch 6/20] loss 0.412  val_f1 0.683  lat 151ms
[epoch 7/20] loss 0.398  val_f1 0.691  lat 149ms
<span class="cursor"></span></pre></div>`
          : ''
      }
    </div>
  </div>`;
}

function gitTab(e) {
  if (e.id !== 'timing') return '<div class="empty">没有未提交的更改</div>';
  const d = diffs[state.gitFile];
  const diff = d
    ? d.map(([k, a, b, t]) => `<div class="dl ${k}"><i>${a}</i><i>${b}</i><span>${k === 'add' ? '+' : k === 'del' ? '−' : ''}</span><span>${esc(t)}</span></div>`).join('')
    : (files[state.gitFile] || '').split('\n').map((t, i) => `<div class="dl add"><i></i><i>${i + 1}</i><span>+</span><span>${esc(t)}</span></div>`).join('');
  return `<div class="git">
    <div class="gside">
      <div class="gbranch">${icon('branch', 'i-sm')}<b>main</b><span class="meta">领先 1</span><span style="flex:1"></span><button class="ib" title="拉取">${icon('download', 'i-sm')}</button><button class="ib" title="推送">${icon('upload', 'i-sm')}</button><button class="ib" title="分支、Stash 与 Worktree">${icon('more', 'i-sm')}</button></div>
      <textarea class="gmsg" placeholder="提交说明" aria-label="提交说明">${esc(state.gitMsg)}</textarea>
      <div class="gacts"><button class="btn ghost sm" data-act="aimsg">${icon('ai', 'i-sm')}写说明</button><span style="flex:1"></span><button class="btn primary sm" data-act="commit">提交 ${changes.length} 个文件</button></div>
      <div class="glabel"><span>更改</span><span>${changes.length}</span></div>
      ${changes.map((c) => `<button class="gfile ${state.gitFile === c.path ? 'on' : ''}" data-act="gitfile" data-k="${c.path}"><span class="s ${c.s}">${c.s}</span><span class="path">${c.path}</span><span class="delta">+${c.add} −${c.del}</span></button>`).join('')}
      <div class="glabel"><span>历史</span></div>
      ${commits.map(([h, m, who, when]) => `<div class="gcommit"><code>${h}</code><span>${m}</span><small>${who} · ${when}</small></div>`).join('')}
    </div>
    <div class="gdiff"><div class="dh">${icon('file', 'i-sm')}<b>${state.gitFile}</b><span class="meta">${changes.find((c) => c.path === state.gitFile).s === 'A' ? '新文件' : '已修改'}</span></div>${diff}</div>
  </div>`;
}

function envTab(e) {
  if (e.id === 'data')
    return `<div class="env"><div class="page-inner narrow"><div class="interp">${icon('terminal')}<div class="t"><b>还没有 Python 环境</b><small>选择已有解释器，或在这个实验里新建虚拟环境。</small></div><button class="btn secondary sm">选择解释器</button><button class="btn primary sm">新建 venv</button></div></div></div>`;
  return `<div class="env"><div class="page-inner narrow">
    <div class="section first"><h2>解释器</h2>
      <div class="interp">${icon('terminal')}<div class="t"><b>${e.py}</b><small>F:\\ScientifyData\\workspace\\proactive\\${e.name}\\.venv</small></div>${dot('ok', '可用')}<button class="btn secondary sm">切换</button></div></div>
    <div class="section"><h2>已安装的包 <small>42</small></h2>
      <div class="toolbar"><label class="field">${icon('search', 'i-sm')}<input placeholder="搜索包"></label><span style="flex:1"></span><button class="btn ghost sm">按 requirements.txt 安装</button><button class="btn secondary sm" data-act="install">${icon('plus', 'i-sm')}安装包</button></div>
      <div class="pk th"><span>名称</span><span>版本</span><span>最新</span><span></span></div>
      ${packages.map(([n, v, l]) => `<div class="pk"><code>${n}</code><span class="v">${v}</span><span>${l ? dot('warn', `可更新到 ${l}`) : ''}</span><span>${l ? `<button class="btn ghost sm">更新</button>` : ''}</span></div>`).join('')}
    </div>
  </div></div>`;
}

/* ---------------- Writing (planned) ---------------- */
function writePage() {
  if (parts()[3] === 'refs') return refsPage();
  const ms = manuscripts.find((x) => x.id === state.manuscript);
  return `<div class="mod">
    <div class="rbar">
      ${ms.files.map((f, i) => `<button class="etab ${i === 0 ? 'on' : ''}"><span>${f}</span></button>`).join('')}
      <span style="flex:1"></span>
      ${dot('ok', '已编译 · 12 秒前')}<span class="vline"></span>
      <button class="btn ghost sm" data-act="cite">${icon('quote', 'i-sm')}插入引用</button>
      <button class="btn ghost sm">${icon('chart', 'i-sm')}插入结果</button>
      <button class="btn primary sm" data-act="compile">${icon('play', 'i-sm')}编译</button>
    </div>
    <div class="write">
      <div class="src"><span class="cmd">\\section</span>{Proactive Timing}
<span class="cm">% 引用来自文献库，输入 \\cite 自动补全</span>
Most assistants respond only when asked. Proactive
systems instead decide <span class="cmd">\\emph</span>{when} to act
<span class="cmd">\\cite</span>{yang2026proactive, lu2025proactive}.

<span class="cmd">\\subsection</span>{Timing as a Separate Decision}
Separating the timing decision from response
generation reduces false triggers (Table~<span class="cmd">\\ref</span>{tab:abl}).

<span class="cmd">\\input</span>{tables/ablation} <span class="cm">% 来自运行 timing-abl-03</span></div>
      <div class="pv"><article class="sheet"><h2 style="margin-top:0">3 Proactive Timing</h2><p>Most assistants respond only when asked. Proactive systems instead decide <i>when</i> to act [12, 18].</p><h2>3.1 Timing as a Separate Decision</h2><p>Separating the timing decision from response generation reduces false triggers (Table 2).</p><div class="fig" style="height:90px">Table 2 · 消融结果（来自 timing-abl-03）</div></article></div>
    </div>
  </div>`;
}

function refsPage() {
  const missing = refs.filter((r) => !r.paper).length;
  return `<div class="page"><div class="page-inner">
    ${pageHead('参考文献', '', `<button class="btn secondary" data-act="bibtex">${icon('copy')}导出 BibTeX</button><button class="btn primary" data-act="cite">${icon('plus')}从文献库添加</button>`)}
    <div class="toolbar"><span class="meta">主动式交互综述引用了 ${refs.length} 篇，其中 ${missing} 篇不在文献库</span></div>
    <table class="ptable"><thead><tr><th>引用键</th><th>标题</th><th>年份</th><th>引用</th><th>文献库</th></tr></thead><tbody>${refs
      .map((r) => {
        const x = r.paper && paperOf(r.paper);
        return `<tr ${x ? `data-go="p/${parts()[1]}/read/${x.id}"` : ''}><td><code class="key">${r.key}</code></td><td class="ell">${esc(x ? x.title : r.title)}</td><td class="meta num">${x ? x.year : r.year}</td><td class="meta num">${r.cited} 处</td>
          <td>${x ? dot('ok', '已关联') : `<span class="state warn"><span class="d"></span>不在文献库</span> <button class="btn ghost sm" data-act="fetchref">查找</button>`}</td></tr>`;
      })
      .join('')}</tbody></table>
  </div></div>`;
}

/* ---------------- Right panel: AI and notes ---------------- */
function contextChips() {
  const [kind, , mod, a] = parts();
  const chip = (ic, text) => `<span class="ctx">${icon(ic, 'i-sm')}<span>${esc(text)}</span><button title="移除">${icon('x', 'i-sm')}</button></span>`;
  const out = [];
  if (mod === 'read') out.push(chip('book', `${paperOf(a).short} · 第 ${paperOf(a).page} 页`));
  if (mod === 'lib') out.push(chip('book', groupName(state.folder) === '全部论文' ? paperOf(state.paper).short : `${groupName(state.folder)} · ${papers.filter((x) => inGroup(x, state.folder)).length} 篇`));
  if (mod === 'subs') out.push(chip('rss', `新论文 · ${feed.length} 篇`));
  if (mod === 'notes') out.push(chip('note', notes.find((n) => n.id === state.note)?.title || '笔记'));
  if (mod === 'exp' && a) {
    const r = runs.find((x) => x.id === state.run);
    out.push(chip('flask', `${expOf(a).name}${r ? ` · ${r.name}` : ''}`));
    if (parts()[4] === 'code') out.push(chip('file', state.file));
  }
  if (mod === 'write') out.push(chip('pen', 'main.tex · 第 3 节'));
  if (state.selection) out.push(chip('quote', '选中 1 段'));
  return out.join('');
}

function composer() {
  return `<div class="composer">
    <div class="ctxchips">${contextChips()}</div>
    <textarea placeholder="问点什么，或描述要完成的任务" rows="2"></textarea>
    <div class="row2"><button class="ib" title="引用论文、笔记或文件  @">${icon('at', 'i-sm')}</button><button class="ib" title="附加文件">${icon('clip', 'i-sm')}</button><span class="spacer"></span><button class="ib meta" data-pop="model">DeepSeek V4 Flash ${icon('down', 'i-sm')}</button><button class="ib meta" data-pop="perm">询问 ${icon('down', 'i-sm')}</button><button class="send" title="发送  Enter">${icon('up', 'i-sm')}</button></div>
  </div>`;
}

function auxPanel() {
  if (!state.aux) return '<div></div>';
  const [kind, pid, mod, a] = parts();
  const inProject = kind === 'p';
  const inReader = mod === 'read';
  const notesLabel = inReader ? '论文笔记' : '笔记';
  const head = `<div class="auxhead">
    <button class="tab" data-act="auxtab" data-tab="ai" aria-selected="${state.aux === 'ai'}">AI 助手</button>
    ${mod !== 'notes' ? `<button class="tab" data-act="auxtab" data-tab="notes" aria-selected="${state.aux === 'notes'}">${notesLabel}</button>` : ''}
    <span class="spacer"></span>
    ${state.aux === 'ai' ? `<button class="ib" title="新对话" data-act="newchat">${icon('plus')}</button><button class="ib" title="对话历史">${icon('clock')}</button>` : ''}
    <button class="ib" data-act="closeaux" title="关闭">${icon('x')}</button></div>`;
  if (state.aux === 'notes') {
    let body;
    if (inReader) {
      const x = paperOf(a);
      body = `<div class="pnote"><h3>${esc(x.title)}</h3>
        ${Array.from({ length: state.excerpts }).map((_, i) => `<div class="excerpt">${i ? '“A response decision enables output generation, not the ingestion of new observations.”' : '“important tasks emerge from continuously changing world states before a person explicitly formulates them.”'}<div class="src-line">第 ${i ? 4 : 1} 页 · ${i ? '刚刚' : '昨天'}摘录</div></div>`).join('')}
        <p class="pbody">核心主张：任务在用户说出口之前就出现了，所以系统要持续观察、自己判断时机。和我们的设定最接近的是 5.2 的“长期规则”场景。</p></div>`;
    } else {
      const n = notes.find((x) => x.id === state.auxNote);
      body = `<div class="pnote">
        <button class="notepick" data-pop="notepick">${esc(n.title)}${icon('down', 'i-sm')}</button>
        <div class="meta">${n.time}编辑 · <button class="linkbtn" data-go="p/${pid}/notes" data-note="${n.id}">在笔记页打开</button></div>
        <div class="prose sm" contenteditable="true"><p>${esc(n.excerpt)}</p><ul><li>去掉音频：看误触发率</li><li>去掉状态：看延迟</li><li>窗口 4s / 8s 对比</li></ul></div></div>`;
    }
    return `<aside class="aux" aria-label="${notesLabel}">${head}${body}</aside>`;
  }
  const steps = `<div class="steps" data-act="steps">${icon(state.stepsOpen ? 'down' : 'right', 'i-sm')}读取论文第 1–33 页，查找“Response Model” · 21 秒</div>
    ${state.stepsOpen ? '<div class="steplist"><span>读取 第 1–8 页</span><span>读取 第 9–16 页</span><span>读取 第 17–24 页</span><span>读取 第 25–33 页</span><span>在论文中查找 “Response Model” · 6 处</span></div>' : ''}`;
  const approval =
    state.approved === null
      ? `<div class="approve"><div class="q">${icon('shield', 'i-sm')}新建笔记「ProAgent 方法拆解」</div><div class="what">412 字，放在 Proactive 的笔记里。</div><div class="acts"><button class="btn primary sm" data-act="approve" data-v="yes">允许</button><button class="btn secondary sm" data-act="approve" data-v="no">拒绝</button><button class="btn ghost sm">查看内容</button></div></div>`
      : `<div class="meta">${icon('check', 'i-sm')} ${state.approved ? '已新建笔记「ProAgent 方法拆解」' : '已拒绝新建笔记'}</div>`;
  const chat = inProject
    ? `<div class="session"><b>Response Model 的作用</b>${icon('down', 'i-sm')}<span style="flex:1"></span><span class="meta">${esc(currentProject().name)}</span></div>
      <div class="chat">
        <div class="msg user">这篇论文的方法分几部分？时机模型和响应模型各自解决什么问题？</div>
        <div class="msg ai">${steps}
          <p>方法由两个模型组成，二者共享同一条持续的观察流：</p>
          <ol><li><b>时机模型</b>持续读取视频、音频和状态，判断此刻要不要介入。没有需要时保持静默 <span class="cite" data-go="p/${pid}/read/p1">p.3</span></li>
          <li><b>响应模型</b>被触发后决定对谁回应、回应什么，可以生成回复，也可以调用设备执行动作 <span class="cite" data-go="p/${pid}/read/p1">p.4</span></li></ol>
          <p>实验显示在显式目标和长期规则两种设定下，时机更准、误触发更少 <span class="cite" data-go="p/${pid}/read/p1">p.9–11</span>。</p>
        </div>
        <div class="msg user">整理成一篇笔记</div>
        <div class="msg ai">${approval}</div>
      </div>`
    : '';
  return `<aside class="aux" aria-label="AI 助手">${head}${chat}${composer()}</aside>`;
}

/* ---------------- Overlays ---------------- */
const commands = [
  { label: '新建笔记', key: 'Ctrl Shift N', icon: 'note', act: 'newnote' },
  { label: '导入论文', key: 'Ctrl I', icon: 'upload', act: 'import' },
  { label: '问 AI', key: 'Ctrl J', icon: 'ai', act: 'openai' },
  { label: '新建实验', key: '', icon: 'flask', act: 'newexp' },
  { label: '新建项目', key: '', icon: 'plus', act: 'newproject' },
  { label: '切换到深色', key: '', icon: 'settings', act: 'theme-night' },
  { label: '打开设置', key: 'Ctrl ,', icon: 'settings', act: 'settings' },
];
function paletteItems(q) {
  const term = q.trim().toLowerCase();
  const cmdOnly = term.startsWith('>');
  const t = cmdOnly ? term.slice(1).trim() : term;
  const hit = (s) => !t || s.toLowerCase().includes(t);
  const p = currentProject() || projects[0];
  const out = [];
  if (!cmdOnly) {
    const ps = papers.filter((x) => hit(x.title)).map((x) => ({ icon: 'book', label: x.title, sub: `${p.name} · ${x.venue} ${x.year}`, go: `p/${p.id}/read/${x.id}` }));
    const ns = notes.filter((x) => hit(x.title)).map((x) => ({ icon: 'note', label: x.title, sub: `${p.name} · ${x.time}`, go: `p/${p.id}/notes`, note: x.id }));
    const es = experiments.filter((x) => hit(x.name) || hit(x.desc)).map((x) => ({ icon: 'flask', label: x.name, sub: x.desc, go: `p/${p.id}/exp/${x.id}/runs` }));
    const prs = projects.filter((x) => !x.archived && hit(x.name)).map((x) => ({ icon: 'folder', label: x.name, sub: x.team ? '团队项目' : '我的项目', go: `p/${x.id}` }));
    if (!t) {
      out.push(['最近', [ps[0], ns[0], es[0]]]);
      out.push(['项目', prs.slice(0, 4)]);
    } else {
      if (ps.length) out.push(['论文', ps.slice(0, 5)]);
      if (ns.length) out.push(['笔记', ns.slice(0, 4)]);
      if (es.length) out.push(['实验', es]);
      if (prs.length) out.push(['项目', prs]);
    }
  }
  const cs = commands.filter((c) => hit(c.label)).map((c) => ({ icon: c.icon, label: c.label, key: c.key, act: c.act }));
  if (cs.length) out.push(['命令', t ? cs : cs.slice(0, 4)]);
  return out;
}
function palette() {
  const q = palette.query || '';
  const list = paletteItems(q);
  let i = -1;
  return `<div class="scrim" data-act="closeall"></div>
  <div class="palette" role="dialog" aria-label="搜索与命令">
    <div class="q">${icon('search')}<input id="pq" value="${esc(q)}" placeholder="搜索论文、笔记、实验、项目，或输入 > 执行命令" autocomplete="off"><kbd>Esc</kbd></div>
    <div class="res">${
      list.length
        ? list
            .map(
              ([g, items]) => `<div class="grp">${g}</div>${items
                .map((it) => {
                  i += 1;
                  return `<button class="pitem ${i === state.paletteIndex ? 'on' : ''}" data-pi="${i}" ${it.go ? `data-go="${it.go}"` : ''} ${it.note ? `data-note="${it.note}"` : ''} ${it.act ? `data-cmd="${it.act}"` : ''}>${icon(it.icon)}<b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}${it.key ? `<kbd>${it.key}</kbd>` : ''}</button>`;
                })
                .join('')}`,
            )
            .join('')
        : `<div class="empty" style="height:120px">没有找到“${esc(q)}”</div>`
    }</div>
  </div>`;
}

function settingsDialog() {
  const sec = state.settings;
  const p = currentProject();
  const nav = [
    ...(p ? [['project', '项目设置']] : []),
    ['general', '通用'],
    ['look', '外观'],
    ['ai', 'AI 模型'],
    ['keys', '快捷键'],
    ['translate', '划词翻译'],
    ['account', '账号与协作'],
    ['data', '数据与备份'],
    ['about', '关于'],
  ];
  const swatch = (bg, side, ink) => `<span class="sw" style="background:${bg}"><span style="background:${side}"></span><span style="display:grid;align-content:center;gap:5px;padding:8px"><i style="display:block;height:5px;width:70%;background:${ink};border-radius:3px"></i><i style="display:block;height:5px;width:45%;background:${ink};opacity:.35;border-radius:3px"></i></span></span>`;
  let content = '';
  if (sec === 'project' && p)
    content = `<h3>${esc(p.name)}</h3>
      <div class="setrow"><div class="lab"><b>名称</b></div><input class="input" value="${esc(p.name)}"></div>
      <div class="setrow"><div class="lab"><b>研究问题</b></div><input class="input" value="${esc(p.question)}"></div>
      <div class="setrow"><div class="lab"><b>文献文件夹</b></div><button class="btn secondary sm">更改</button></div>
      <div class="setrow"><div class="lab"><b>在多台设备上同步</b></div><span class="switch ${p.sync === 'local' ? '' : 'on'}"></span></div>
      <div class="setrow"><div class="lab"><b>成员</b></div><button class="btn secondary sm" data-act="closeall">管理成员</button></div>
      <div class="setrow"><div class="lab"><b>归档</b></div><button class="btn secondary sm">归档项目</button></div>
      <div class="setrow"><div class="lab"><b>删除</b></div><button class="btn danger sm">删除项目…</button></div>`;
  else if (sec === 'look')
    content = `<h3>外观</h3>
      <div class="setrow"><div class="lab"><b>配色</b></div></div>
      <div class="themes" style="margin:12px 0 6px">
        <button class="themecard" data-act="theme" data-k="graphite" aria-pressed="${state.theme === 'graphite'}">${swatch('#fff', '#f4f4f5', '#18181b')}石墨</button>
        <button class="themecard" data-act="theme" data-k="paper" aria-pressed="${state.theme === 'paper'}">${swatch('#fcfbf8', '#f1efea', '#23466f')}纸</button>
        <button class="themecard" data-act="theme" data-k="night" aria-pressed="${state.theme === 'night'}">${swatch('#151517', '#0e0e10', '#ededef')}夜</button>
      </div>
      <div class="setrow"><div class="lab"><b>跟随系统</b></div><span class="switch on"></span></div>
      <div class="setrow"><div class="lab"><b>界面密度</b></div><div class="seg2"><button aria-pressed="false">紧凑</button><button aria-pressed="true">标准</button></div></div>
      <div class="setrow"><div class="lab"><b>阅读字号</b></div><div class="seg2"><button>小</button><button aria-pressed="true">中</button><button>大</button></div></div>`;
  else if (sec === 'ai')
    content = `<h3>AI 模型</h3>
      <div class="rows">
        <div class="row"><div class="t"><b>DeepSeek</b><small>deepseek-v4-flash · 默认</small></div>${dot('ok', '对话')}${dot('ok', 'Agent')}<button class="btn ghost sm">编辑</button></div>
        <div class="row"><div class="t"><b>本机 Ollama</b><small>qwen3:32b</small></div>${dot('ok', '对话')}${dot('bad', 'Agent')}<button class="btn ghost sm">编辑</button></div>
      </div>
      <div style="margin-top:12px"><button class="btn secondary sm">${icon('plus', 'i-sm')}新建连接</button></div>
      <p class="meta" style="margin-top:18px">只有你发出的消息和附件会发给模型服务；密钥只保存在这台电脑上。</p>`;
  else if (sec === 'keys')
    content = `<h3>快捷键</h3>${[
      ['搜索与命令', 'Ctrl K'],
      ['AI 助手', 'Ctrl J'],
      ['新建笔记', 'Ctrl Shift N'],
      ['导入论文', 'Ctrl I'],
      ['显示或隐藏侧边栏', 'Ctrl \\'],
      ['返回上一页', 'Alt ←'],
    ]
      .map(([l, k]) => `<div class="setrow"><div class="lab"><b style="font-weight:400">${l}</b></div><kbd style="font-size:12px;color:var(--text-2)">${k}</kbd></div>`)
      .join('')}`;
  else
    content = `<h3>${nav.find((n) => n[0] === sec)[1]}</h3>
      <div class="setrow"><div class="lab"><b>界面语言</b></div><div class="seg2"><button aria-pressed="true">中文</button><button>English</button></div></div>
      <div class="setrow"><div class="lab"><b>启动时打开</b></div><div class="seg2"><button aria-pressed="true">项目中心</button><button>上次的项目</button></div></div>
      <div class="setrow"><div class="lab"><b>关闭窗口后留在托盘</b></div><span class="switch on"></span></div>`;
  return `<div class="scrim" data-act="closeall"></div>
  <div class="dialog" role="dialog" aria-label="设置">
    <nav><h2>设置</h2>${nav.map(([k, l]) => `<button class="nav-item" data-act="setsec" data-k="${k}" ${sec === k ? 'aria-current="page"' : ''}><span>${l}</span></button>`).join('')}</nav>
    <div class="content">${content}</div>
  </div>`;
}

const POPW = { bell: 340, perm: 280, share: 360, switcher: 280, notepick: 300, import: 270, runcfg: 270 };
function popover() {
  const pop = state.pop;
  if (!pop) return '';
  const style = `left:${pop.x}px;top:${pop.y}px;width:${POPW[pop.kind] || 230}px`;
  const wrap = (html) => `<div class="pop" style="${style}" data-pop-body>${html}</div>`;
  const p = project(pop.id) || currentProject();
  if (pop.kind === 'switcher') {
    const cur = currentProject();
    const row = (x) => `<button class="mi" data-go="p/${x.id}">${mini(x)}<span class="grow">${esc(x.name)}</span>${cur && cur.id === x.id ? icon('check', 'i-sm') : ''}</button>`;
    return wrap(`<label class="field pf">${icon('search', 'i-sm')}<input placeholder="查找项目"></label>
      <div class="plabel">我的项目</div>${projects.filter((x) => !x.team && !x.archived).map(row).join('')}
      <div class="plabel">团队项目</div>${projects.filter((x) => x.team && !x.archived).map(row).join('')}
      <hr><button class="mi" data-act="settings" data-sec="project">${icon('settings')}项目设置…</button>
      <button class="mi" data-go="mine">${icon('grid')}项目中心</button>
      <button class="mi" data-act="newproject">${icon('plus')}新建项目</button>`);
  }
  if (pop.kind === 'share') {
    const mem = p.team ? p.members : ['潘'];
    const roles = { [p.owner || '潘']: '所有者' };
    const roleOf = (m, i) => roles[m] || ['编辑者', '审阅者', '查看者'][(i - 1) % 3];
    return wrap(`<div class="ph2"><b>共享「${esc(p.name)}」</b><span>${p.team ? `${mem.length} 位成员` : '只有你'}</span></div>
      <div class="invite-row"><label class="field">${icon('userplus', 'i-sm')}<input placeholder="对方的手机号"></label><button class="chip">编辑者${icon('down', 'i-sm')}</button><button class="btn primary sm" data-act="invite">邀请</button></div>
      <div class="members">${mem.map((m, i) => `<div class="member"><span class="avatar">${m}</span><span class="who"><b>${people[m]}${m === '潘' ? '（你）' : ''}</b><small>${phones[m]}</small></span><button class="ib meta">${roleOf(m, i)}${roleOf(m, i) === '所有者' ? '' : icon('down', 'i-sm')}</button></div>`).join('')}</div>
      <hr><button class="mi">${icon('link')}复制邀请码<kbd>SFY-7Q4K</kbd></button>`);
  }
  if (pop.kind === 'bell')
    return wrap(`<div class="ph2"><b>通知</b></div>${pending
      .map((x) => `<button class="mi tall" data-act="pending" data-kind="${x.act}"><span class="mi-ic">${icon(x.icon)}</span><span class="grow"><span style="display:block">${x.text}</span><span class="meta">${x.meta}</span></span></button>`)
      .join('')}`);
  if (pop.kind === 'me')
    return wrap(`<div class="ph2"><b>潘子禾</b><span>138****6688</span></div><hr>
      <button class="mi" data-act="settings">${icon('settings')}设置<kbd>Ctrl ,</kbd></button>
      <button class="mi" data-act="theme-cycle">${icon('globe')}切换配色</button>
      <button class="mi" data-act="settings" data-sec="account">${icon('cloud')}账号与协作</button><hr>
      <button class="mi">${icon('logout')}退出登录</button>`);
  if (pop.kind === 'import')
    return wrap(`<button class="mi" data-act="import">${icon('upload')}<span class="grow">选择 PDF 文件</span><kbd>Ctrl I</kbd></button>
      <button class="mi" data-act="import">${icon('link')}粘贴 DOI 或 arXiv 链接</button>
      <button class="mi" data-act="import">${icon('book')}从 BibTeX 或 Zotero 导入</button>`);
  if (pop.kind === 'runcfg')
    return wrap(`<div class="plabel">运行配置</div>
      <button class="mi" data-act="newrun">${icon('check', 'i-sm')}<span class="grow">train.yaml</span></button>
      <button class="mi" data-act="newrun"><span class="sp"></span><span class="grow">ablation.yaml · 去掉音频</span></button>
      <hr><button class="mi" data-act="newrun">${icon('plus')}新建运行配置…</button>`);
  if (pop.kind === 'notepick')
    return wrap(`${notes.map((n) => `<button class="mi" data-act="auxnote" data-id="${n.id}">${n.id === state.auxNote ? icon('check', 'i-sm') : '<span class="sp"></span>'}<span class="grow ell">${esc(n.title)}</span></button>`).join('')}<hr><button class="mi" data-act="newnote">${icon('plus')}新建笔记</button>`);
  if (pop.kind === 'model')
    return wrap(`<button class="mi">${icon('check')}DeepSeek V4 Flash</button><button class="mi"><span class="sp"></span>本机 Ollama · qwen3</button><hr><button class="mi" data-act="settings" data-sec="ai">${icon('settings')}管理模型</button>`);
  if (pop.kind === 'perm')
    return wrap(`<button class="mi tall">${icon('check')}<span class="grow"><b style="display:block;font-weight:500">询问</b><span class="meta">在沙箱里运行；越界和 Git 操作前询问</span></span></button><button class="mi tall"><span class="sp"></span><span class="grow"><b style="display:block;font-weight:500">完全允许</b><span class="meta">不用沙箱，不再询问</span></span></button>`);
  if (pop.kind === 'translate')
    return wrap(`<div style="padding:6px 8px"><div class="meta" style="margin-bottom:6px">翻译 · 英 → 中</div><div style="line-height:1.6">响应决策只负责生成输出，不负责摄取新的观察。</div><div style="display:flex;gap:6px;margin-top:10px"><button class="btn secondary sm" data-act="askselection">${icon('ai', 'i-sm')}继续问 AI</button><button class="btn ghost sm" data-act="excerpt">摘录到笔记</button></div></div>`);
  if (pop.kind === 'ctx') {
    const items = {
      paper: [['book', '阅读', 'Enter'], ['ai', '问 AI', ''], ['quote', '复制引用', 'Ctrl Shift C'], ['folder', '移到文件夹…', ''], ['star', '收藏', ''], ['ext', '在资源管理器中显示', ''], ['-'], ['trash', '移到回收站', 'Del', 'danger', 'trashpaper']],
      folder: [['plus', '新建子文件夹', ''], ['pen', '重命名', 'F2'], ['ext', '在资源管理器中显示', ''], ['-'], ['trash', '移到回收站', '', 'danger']],
      note: [['link', '复制链接', ''], ['folder', '移到其他项目…', ''], ['upload', '导出 Markdown', ''], ['-'], ['trash', '移到回收站', 'Del', 'danger', 'trashnote']],
      run: [['chart', '与其他运行对比', ''], ['note', '写进笔记', ''], ['refresh', '重新运行', ''], ['-'], ['trash', '删除运行记录', '', 'danger']],
      exp: [['play', '运行', ''], ['terminal', '打开终端', ''], ['ext', '在资源管理器中显示', ''], ['-'], ['archive', '归档', ''], ['trash', '删除实验…', '', 'danger']],
      sub: [['plus', '存入文献库', ''], ['globe', '在内置浏览器中打开', ''], ['-'], ['x', '不感兴趣', '']],
      project: [['settings', '项目设置…', ''], ['users', '共享…', ''], ['cloud', '多设备同步…', ''], ['ext', '显示文献文件夹', ''], ['-'], ['archive', '归档', ''], ['trash', '删除项目…', '', 'danger']],
    }[pop.ctx];
    return wrap(items.map((it) => (it[0] === '-' ? '<hr>' : `<button class="mi ${it[3] || ''}" data-act="${it[4] || 'closeall'}">${icon(it[0])}<span class="grow">${it[1]}</span>${it[2] ? `<kbd>${it[2]}</kbd>` : ''}</button>`)).join(''));
  }
  return '';
}

/* ---------------- Render ---------------- */
function mainPage() {
  const [kind, , mod] = parts();
  if (kind === 'team') return teamPage();
  if (kind !== 'p') return minePage();
  return { lib: libPage, read: readPage, web: webPage, subs: subsPage, notes: notesPage, exp: expPage, write: writePage }[mod]();
}

function render() {
  document.body.dataset.theme = state.theme;
  const app = document.getElementById('app');
  app.dataset.theme = state.theme;
  const focusPalette = state.palette && document.activeElement?.id !== 'pq';
  app.innerHTML = `${titlebar()}
    <div class="body ${state.sidebar ? '' : 'no-side'} ${state.aux ? 'aux-open' : ''}">
      ${sidebar()}
      <main class="main">${mainPage()}</main>
      ${auxPanel()}
    </div>
    ${state.palette ? palette() : ''}
    ${state.settings ? settingsDialog() : ''}
    ${popover()}
    ${state.toast ? `<div class="toast" role="status">${esc(state.toast.text)}${state.toast.undo ? '<button data-act="undo">撤销</button>' : ''}</div>` : ''}`;
  renderReview();
  placeSelectionBar();
  fitPop();
  if (state.palette) {
    const input = document.getElementById('pq');
    if (focusPalette || document.activeElement !== input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

function placeSelectionBar() {
  const bar = document.querySelector('.selpop');
  const mark = document.querySelector('mark.sel');
  if (!bar || !mark) return;
  const sheet = bar.offsetParent.getBoundingClientRect();
  const first = mark.getClientRects()[0];
  const room = sheet.width - bar.offsetWidth - 12;
  bar.style.left = `${Math.max(12, Math.min(room, first.left - sheet.left - 8))}px`;
  bar.style.top = `${first.top - sheet.top - bar.offsetHeight - 8}px`;
  bar.style.visibility = 'visible';
}

// Menus open below their trigger and flip above it when the window has no room.
function fitPop() {
  const el = document.querySelector('.pop');
  if (!el || !state.pop) return;
  const h = document.getElementById('app').clientHeight;
  if (state.pop.y + el.offsetHeight > h - 8) el.style.top = `${Math.max(8, state.pop.above - el.offsetHeight)}px`;
}

function renderReview() {
  const pages = [
    ['项目中心', [['mine', '我的项目'], ['team', '团队项目']]],
    ['文献', [['p/proactive/lib', '文献库'], ['p/proactive/read/p1', '阅读'], ['p/proactive/subs', '订阅'], ['p/proactive/web/w1', '内置浏览器']]],
    ['笔记', [['p/proactive/notes', '笔记']]],
    ['实验', [['p/proactive/exp', '全部实验'], ['p/proactive/exp/timing/runs', '运行'], ['p/proactive/exp/timing/code', '代码'], ['p/proactive/exp/timing/git', '版本'], ['p/proactive/exp/timing/env', '环境']]],
    ['写作（规划中）', [['p/proactive/write', '稿件'], ['p/proactive/write/refs', '参考文献']]],
  ];
  document.getElementById('review').innerHTML = `<strong>Scientify 整体重设计 v2</strong><span>交互原型 · 虚构数据</span>
    <span class="seg">${[
      ['graphite', '石墨'],
      ['paper', '纸'],
      ['night', '夜'],
    ]
      .map(([k, l]) => `<button data-act="theme" data-k="${k}" aria-pressed="${state.theme === k}">${l}</button>`)
      .join('')}</span>
    <span class="spacer"></span>
    <span>Ctrl K 搜索 · Ctrl J AI · 右键行看菜单</span>
    <select id="jump" aria-label="跳到页面"><option value="">跳到页面…</option>${pages
      .map(([g, list]) => `<optgroup label="${g}">${list.map(([r, l]) => `<option value="${r}" ${state.route === r ? 'selected' : ''}>${l}</option>`).join('')}</optgroup>`)
      .join('')}</select>`;
}

/* ---------------- Events ---------------- */
function openPop(kind, el, extra = {}) {
  const win = document.getElementById('app').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const width = POPW[kind] || 230;
  let x = r.left - win.left;
  if (x + width > win.width - 8) x = r.right - win.left - width;
  state.pop = { kind, x: Math.max(8, x), y: r.bottom - win.top + 6, above: r.top - win.top - 6, id: el.dataset.id, ...extra };
  render();
}
function openContext(ctx, id, clientX, clientY) {
  const win = document.getElementById('app').getBoundingClientRect();
  const y = clientY - win.top;
  state.pop = { kind: 'ctx', ctx, id, x: Math.min(clientX - win.left, win.width - 240), y, above: y };
  render();
}

const actions = {
  sidebar: () => (state.sidebar = !state.sidebar),
  back: () => step(-1),
  fwd: () => step(1),
  palette: () => {
    state.palette = true;
    state.paletteIndex = 0;
    palette.query = '';
  },
  aux: (el) => {
    const tab = el.dataset.tab || 'ai';
    state.aux = state.aux === tab ? null : tab;
  },
  auxtab: (el) => (state.aux = el.dataset.tab),
  openai: () => {
    state.aux = 'ai';
    state.pop = null;
  },
  closeaux: () => (state.aux = null),
  closeall: () => {
    state.palette = false;
    state.settings = null;
    state.pop = null;
  },
  settings: (el) => {
    state.pop = null;
    state.palette = false;
    state.settings = el?.dataset.sec || (currentProject() ? 'project' : 'look');
  },
  setsec: (el) => (state.settings = el.dataset.k),
  theme: (el) => (state.theme = el.dataset.k),
  'theme-night': () => (state.theme = 'night'),
  'theme-cycle': () => {
    const order = ['graphite', 'paper', 'night'];
    state.theme = order[(order.indexOf(state.theme) + 1) % 3];
    state.pop = null;
  },
  mfilter: (el) => (state.mineFilter = el.dataset.k),
  shelf: (el) => (state.shelf = el.dataset.k),
  download: () => {
    state.downloaded = true;
    toast('已下载「Reading Group」到这台电脑');
  },
  accept: () => {
    const x = invites[0];
    if (!project(x.id)) projects.push({ ...x, team: true, owner: x.from, sync: 'ok', opened: '刚刚' });
    state.inviteDone = true;
    toast(`已下载「${x.name}」`);
    go(`p/${x.id}`);
  },
  ignoreinvite: () => {
    state.inviteDone = true;
    toast('已忽略邀请', true);
  },
  folder: (el) => {
    state.folder = el.dataset.k;
    if (parts()[2] !== 'lib') go(`${base()}/lib`);
  },
  pick: (el) => {
    if (state.paper === el.dataset.id && state.preview) return go(`${base()}/read/${el.dataset.id}`);
    state.paper = el.dataset.id;
    state.preview = true;
  },
  closetab: (el) => {
    const { k, id } = el.dataset;
    state.tabs = state.tabs.filter((t) => !(t.kind === k && t.id === id));
    const [, pid, mod, a] = parts();
    if (mod === k && a === id) {
      const next = state.tabs[state.tabs.length - 1];
      go(next ? `p/${pid}/${next.kind}/${next.id}` : `p/${pid}/lib`);
    }
  },
  newtab: () => {
    if (!state.tabs.some((t) => t.kind === 'web')) state.tabs.push({ kind: 'web', id: 'w1' });
    go(`${base()}/web/w1`);
  },
  savepdf: () => toast('已存入文献库：When to Speak（未读）'),
  source: (el) => {
    state.source = el.dataset.k;
    if (parts()[2] !== 'subs') go(`${base()}/subs`);
  },
  addsub: (el) => {
    state.added.add(el.dataset.id);
    toast('已存入文献库，放在「未读」', true);
  },
  outline: () => (state.outline = !state.outline),
  zoom: (el) => (state.zoom = Math.max(70, Math.min(160, state.zoom + Number(el.dataset.d)))),
  select: () => {
    state.selection = true;
    state.pop = null;
  },
  deselect: () => {
    if (state.selection) state.selection = false;
  },
  hl: () => {
    state.highlighted = true;
    state.selection = false;
    toast('已高亮');
  },
  excerpt: () => {
    state.excerpts = 2;
    state.selection = false;
    state.pop = null;
    state.aux = 'notes';
    toast('已摘录到论文笔记');
  },
  askselection: () => {
    state.aux = 'ai';
    state.pop = null;
  },
  translate: (el) => openPop('translate', el),
  copycite: () => {
    state.selection = false;
    toast('已复制引用：Yang et al., 2026, p.4');
  },
  nfilter: (el) => {
    state.noteFilter = el.dataset.k;
    state.note = el.dataset.k === 'trash' ? 't1' : 'n1';
    if (parts()[2] !== 'notes') go(`${base()}/notes`);
  },
  note: (el) => {
    state.note = el.dataset.id;
    if (parts()[2] !== 'notes') go(`${base()}/notes`);
  },
  auxnote: (el) => {
    state.auxNote = el.dataset.id;
    state.pop = null;
  },
  newnote: () => toast('已新建笔记「未命名」'),
  trashnote: () => {
    state.pop = null;
    toast('已移到回收站', true);
  },
  trashpaper: () => {
    state.pop = null;
    toast('已把 PDF 和它的笔记移到回收站', true);
  },
  restore: () => toast('已恢复到全部笔记'),
  purge: () => toast('演示：永久删除前会再确认一次'),
  undo: () => (state.toast = null),
  run: (el) => (state.run = state.run === el.dataset.id ? null : el.dataset.id),
  closerun: () => (state.run = null),
  runnote: () => toast('已把 timing-abl-03 的结果写进笔记'),
  newrun: () => {
    state.pop = null;
    toast('已开始运行 timing-abl-05');
  },
  newexp: () => toast('演示：填写名称，选择代码目录和 Python'),
  terminal: () => {
    const [, pid, mod, a, b] = parts();
    if (mod === 'exp' && b !== 'code') {
      state.terminal = true;
      return go(`p/${pid}/exp/${a || 'timing'}/code`);
    }
    state.terminal = !state.terminal;
  },
  file: (el) => {
    const f = el.dataset.k;
    state.file = f;
    if (!state.openFiles.includes(f)) state.openFiles.push(f);
  },
  closefile: (el) => {
    state.openFiles = state.openFiles.filter((f) => f !== el.dataset.k);
    if (state.file === el.dataset.k) state.file = state.openFiles[0] || 'src/train.py';
  },
  gitfile: (el) => (state.gitFile = el.dataset.k),
  aimsg: () => (state.gitMsg = '拆分时机头，支持按模态做输入消融'),
  commit: () => toast('已提交 2 个文件到 main'),
  install: () => toast('演示：输入包名，安装到当前环境'),
  ms: (el) => {
    state.manuscript = el.dataset.k;
    if (parts()[3] === 'refs' || parts()[2] !== 'write') go(`${base()}/write`);
  },
  compile: () => toast('编译完成 · 12 页'),
  cite: () => toast('演示：输入关键词，从文献库选一篇插入引用'),
  bibtex: () => toast('已复制 8 条 BibTeX'),
  fetchref: () => toast('演示：按标题查找并存入文献库'),
  steps: () => (state.stepsOpen = !state.stepsOpen),
  approve: (el) => {
    state.approved = el.dataset.v === 'yes';
    if (state.approved) toast('已新建笔记「ProAgent 方法拆解」');
  },
  newchat: () => toast('演示：开始新对话'),
  import: () => {
    state.pop = null;
    toast('演示：选择 PDF，或粘贴 DOI / arXiv 链接');
  },
  newproject: () => {
    state.pop = null;
    toast('演示：两步新建项目');
  },
  newteam: () => toast('演示：新建项目并邀请成员'),
  sharelocal: () => toast('演示：选择一个本机项目共享给团队'),
  invite: () => toast('已发送邀请'),
  newfolder: () => toast('演示：在文献文件夹里新建子文件夹'),
  newfeed: () => toast('演示：输入 arXiv 关键词、作者或 RSS 地址'),
  feeds: () => toast('演示：管理订阅源和网站'),
  newms: () => toast('演示：从模板新建稿件'),
  pending: (el) => {
    const k = el.dataset.kind;
    state.pop = null;
    if (k === 'run') {
      state.run = 'r3';
      return go('p/proactive/exp/baseline/runs');
    }
    if (k === 'approve') {
      state.aux = 'ai';
      return go('p/proactive/read/p1');
    }
    if (k === 'invite') return go('team');
    toast('演示：并排对比本机与远端，选择保留哪份');
  },
  ctx: (el) => {
    const r = el.getBoundingClientRect();
    openContext(el.dataset.ctx, el.dataset.id, r.left, r.bottom + 4);
    return 'skip';
  },
};

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act],[data-go],[data-pop],[data-cmd],[data-pi]');
  if (state.pop && !ev.target.closest('[data-pop-body]') && !(t && t.dataset.pop)) {
    state.pop = null;
    if (!t) return render();
  }
  if (!t) return;
  if (t.dataset.cmd) {
    state.palette = false;
    const fn = actions[t.dataset.cmd];
    if (fn) fn(t, ev);
    return render();
  }
  if (t.dataset.pop) {
    ev.stopPropagation();
    return state.pop && state.pop.kind === t.dataset.pop ? ((state.pop = null), render()) : openPop(t.dataset.pop, t);
  }
  if (t.dataset.act) {
    const fn = actions[t.dataset.act];
    if (fn && fn(t, ev) === 'skip') return;
    return render();
  }
  if (t.dataset.go) {
    ev.preventDefault();
    if (t.dataset.run) state.run = t.dataset.run;
    if (t.dataset.note) {
      state.note = t.dataset.note;
      state.noteFilter = 'all';
    }
    return go(t.dataset.go);
  }
});

document.addEventListener('dblclick', (ev) => {
  const row = ev.target.closest('.trow[data-id]');
  if (row) go(`${base()}/read/${row.dataset.id}`);
});

document.addEventListener('contextmenu', (ev) => {
  const row = ev.target.closest('[data-ctx]');
  if (!row) return;
  ev.preventDefault();
  if (row.dataset.ctx === 'paper') state.paper = row.dataset.id;
  if (row.dataset.ctx === 'run') state.run = row.dataset.id;
  openContext(row.dataset.ctx, row.dataset.id, ev.clientX, ev.clientY);
});

document.addEventListener('input', (ev) => {
  if (ev.target.id === 'pq') {
    palette.query = ev.target.value;
    state.paletteIndex = 0;
    render();
  }
});

document.addEventListener('change', (ev) => {
  if (ev.target.id === 'jump' && ev.target.value) go(ev.target.value);
});

document.addEventListener('keydown', (ev) => {
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === 'k') {
    ev.preventDefault();
    if (state.palette) state.palette = false;
    else actions.palette();
    return render();
  }
  if (mod && ev.key.toLowerCase() === 'j') {
    ev.preventDefault();
    state.aux = state.aux === 'ai' ? null : 'ai';
    return render();
  }
  if (mod && ev.key === '\\') {
    ev.preventDefault();
    state.sidebar = !state.sidebar;
    return render();
  }
  if (mod && ev.key === ',') {
    ev.preventDefault();
    actions.settings();
    return render();
  }
  if (ev.key === 'Escape') {
    if (state.palette || state.settings || state.pop || state.selection) {
      state.palette = false;
      state.settings = null;
      state.pop = null;
      state.selection = false;
      return render();
    }
  }
  if (state.palette) {
    const items = [...document.querySelectorAll('.pitem')];
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      state.paletteIndex = (state.paletteIndex + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      return render();
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      items[state.paletteIndex]?.click();
    }
    return;
  }
  // Library keyboard: arrows move, Enter reads, Space shows or hides the paper's details.
  if (parts()[2] === 'lib' && !ev.target.closest('input,textarea,[contenteditable]')) {
    const ids = [...document.querySelectorAll('.trow[data-id]')].map((r) => r.dataset.id);
    const i = ids.indexOf(state.paper);
    if (ev.key === 'ArrowDown' || ev.key === 'j') state.paper = ids[Math.min(ids.length - 1, i + 1)];
    else if (ev.key === 'ArrowUp' || ev.key === 'k') state.paper = ids[Math.max(0, i - 1)];
    else if (ev.key === 'Enter') return go(`${base()}/read/${state.paper}`);
    else if (ev.key === ' ') state.preview = !state.preview;
    else return;
    ev.preventDefault();
    render();
  }
  if (ev.altKey && ev.key === 'ArrowLeft') step(-1);
  if (ev.altKey && ev.key === 'ArrowRight') step(1);
});

window.addEventListener('hashchange', () => {
  const route = location.hash.slice(1);
  if (route && route !== state.route) go(route);
});

let start = location.hash.slice(1);
if (/^p\/[^/]+$/.test(start)) start += '/lib';
if (start) {
  state.route = start;
  state.history = [start];
  const [kind, pid, mod, a] = start.split('/');
  if (kind === 'p') state.last[pid] = start.split('/').slice(2).join('/');
  if (mod === 'read') {
    state.paper = a;
    state.aux = 'notes';
  }
}
render();
