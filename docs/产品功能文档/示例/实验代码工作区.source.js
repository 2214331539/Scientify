import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { tags } from '@lezer/highlight';

const icons = __ICONS__;
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icon = (name) => icons[name] || icons.File;
const btn = (name, action, tip, extra = '') => '<button class="icon-btn" data-action="' + action + '" data-tip="' + esc(tip) + '" aria-label="' + esc(tip) + '" ' + extra + '>' + icon(name) + '</button>';
function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach((node) => { node.innerHTML = icon(node.dataset.icon); }); }

const files = {
  'src/train.py': [
    'from pathlib import Path',
    'import json',
    '',
    'import numpy as np',
    'import pandas as pd',
    'from sklearn.linear_model import LogisticRegression',
    'from sklearn.model_selection import StratifiedKFold, cross_validate',
    'from sklearn.pipeline import make_pipeline',
    'from sklearn.preprocessing import StandardScaler',
    '',
    '',
    'def train(config: dict) -> dict:',
    '    """Evaluate the baseline on fixed stratified folds."""',
    '    dataset = pd.read_csv(config["data_path"])',
    '    X = dataset.drop(columns=["target"])',
    '    y = dataset["target"]',
    '',
    '    # Keep preprocessing inside each fold to avoid data leakage.',
    '    model = make_pipeline(',
    '        StandardScaler(),',
    '        LogisticRegression(',
    '            C=config["regularization"],',
    '            max_iter=600,',
    '            random_state=config["seed"],',
    '        ),',
    '    )',
    '    folds = StratifiedKFold(',
    '        n_splits=config["folds"], shuffle=True,',
    '        random_state=config["seed"],',
    '    )',
    '    scores = cross_validate(',
    '        model, X, y, cv=folds, scoring=["accuracy", "f1_macro"],',
    '    )',
    '    metrics = {',
    '        "f1_macro": float(np.mean(scores["test_f1_macro"])),',
    '        "accuracy": float(np.mean(scores["test_accuracy"])),',
    '    }',
    '',
    '    output = Path(config["output_dir"])',
    '    output.mkdir(parents=True, exist_ok=True)',
    '    (output / "metrics.json").write_text(',
    '        json.dumps(metrics, indent=2), encoding="utf-8",',
    '    )',
    '    return metrics',
    '',
    '',
    'if __name__ == "__main__":',
    '    from dataset import load_config',
    '    print(train(load_config()))',
    '',
  ].join('\n'),
  'src/evaluate.py': [
    'import json', 'from pathlib import Path', '',
    '', 'def read_metrics(run_dir: str) -> dict:',
    '    path = Path(run_dir) / "metrics.json"',
    '    if not path.exists():',
    '        raise FileNotFoundError(f"No metrics found in {run_dir}")',
    '    return json.loads(path.read_text(encoding="utf-8"))', '',
    '', 'if __name__ == "__main__":',
    '    results = read_metrics("outputs/run-018")',
    '    for name, value in results.items():',
    '        print(f"{name:12s} {value:.4f}")', '',
  ].join('\n'),
  'src/dataset.py': ['import argparse', 'from pathlib import Path', 'import yaml', '',
    'def load_config() -> dict:',
    '    parser = argparse.ArgumentParser()',
    '    parser.add_argument("--config", default="configs/baseline.yaml")',
    '    args = parser.parse_args()',
    '    text = Path(args.config).read_text(encoding="utf-8")',
    '    return yaml.safe_load(text)', '',
  ].join('\n'),
  'configs/baseline.yaml': ['# Baseline: fixed dataset and stratified five-fold evaluation',
    'name: baseline-5fold', 'data_path: data/sample.csv', 'seed: 42', 'folds: 5',
    'regularization: 1.0', 'scaler: standard', 'output_dir: outputs/run-018', '',
  ].join('\n'),
  'configs/ablation.yaml': ['# Ablation: disable feature standardization',
    'name: ablation-no-scaler', 'data_path: data/sample.csv', 'seed: 42', 'folds: 5',
    'regularization: 1.0', 'scaler: none', 'output_dir: outputs/run-019', '',
  ].join('\n'),
  'data/sample.csv': ['feature_01,feature_02,feature_03,target', '0.35,1.02,0.63,0', '1.43,0.81,0.27,1',
    '0.29,0.95,0.72,0', '1.27,0.64,0.41,1', '# Fictional fixture; not a research dataset.', '',].join('\n'),
  'outputs/run-018/metrics.json': JSON.stringify({ f1_macro: 0.8342, accuracy: 0.8510, folds: 5, seed: 42, source: 'fictional_design_fixture' }, null, 2),
  'outputs/run-018/confusion_matrix.csv': ['actual,predicted_0,predicted_1', 'class_0,420,58', 'class_1,63,459', ''].join('\n'),
  'README.md': ['# 表格分类基线复现', '', '使用固定分层划分，比较标准化与正则化参数。', '', '## 目录', '', '- src/：训练与评估脚本', '- configs/：运行参数', '- outputs/：每次运行独立产物', '', '这是设计示例中的虚构项目。所有指标均为示例数据。', ''].join('\n'),
  'requirements.txt': ['numpy==2.1.2', 'pandas==2.2.3', 'scikit-learn==1.5.2', 'PyYAML==6.0.2', ''].join('\n'),
};
const tracked = { 'src/train.py': files['src/train.py'].replace('max_iter=600', 'max_iter=200'), 'configs/baseline.yaml': files['configs/baseline.yaml'].replace('regularization: 1.0', 'regularization: 0.1') };
const saved = { ...files };
const states = new Map();
const folds = { src: true, configs: true, data: false, outputs: true, 'outputs/run-018': false };
const configs = {
  baseline: { name: 'Baseline · 5-fold', command: 'python src/train.py --config configs/baseline.yaml', cwd: './', output: './outputs/run-{id}', environment: '.venv · Python 3.12.7' },
  ablation: { name: 'Ablation · no scaler', command: 'python src/train.py --config configs/ablation.yaml', cwd: './', output: './outputs/run-{id}', environment: '.venv · Python 3.12.7' },
};
const runs = [
  { id: 18, name: 'baseline · C=1.0', config: 'baseline', status: 'success', time: '10:41:08', duration: '00:14', metric: 0.8342, accuracy: 0.8510, source: '手动启动', C: '1.0', scaler: 'StandardScaler', commit: 'a92f3b7 + 2 个未提交文件', conclusion: '固定五折划分下，macro-F1 较 C=0.1 提高 0.022。仍需补充不同随机种子，暂不判断差异显著。' },
  { id: 17, name: 'baseline · C=0.1', config: 'baseline', status: 'success', time: '10:26:52', duration: '00:13', metric: 0.8121, accuracy: 0.8380, source: '手动启动', C: '0.1', scaler: 'StandardScaler', commit: 'a92f3b7', conclusion: '较强正则化的基线，使用与后续运行相同的五折划分。' },
  { id: 16, name: 'ablation · no scaler', config: 'ablation', status: 'success', time: '10:12:30', duration: '00:11', metric: 0.8060, accuracy: 0.8290, source: '手动启动', C: '1.0', scaler: 'None', commit: 'a92f3b7', conclusion: '取消特征标准化，记录为后续比较的对照。' },
];
const baseLogs = [
  ['10:41:08', '[INFO] Loaded sample.csv: 1,000 rows, 12 features', 'muted'],
  ['10:41:08', '[INFO] StratifiedKFold(n_splits=5, shuffle=True, seed=42)', ''],
  ['10:41:20', '[INFO] macro-F1: 0.8342 ± 0.0187  |  accuracy: 0.8510', ''],
  ['10:41:22', '[SAVE] outputs/run-018/metrics.json', ''],
  ['10:41:22', '[DONE] Process exited with code 0', 'success'],
];
runs.forEach((run) => { run.logs = baseLogs.map(([, text, style]) => [run.time, text.replace('0.8342', run.metric.toFixed(4)).replace('0.8510', run.accuracy.toFixed(4)).replace('run-018', 'run-' + String(run.id).padStart(3, '0')), style]); run.snapshot = { ...configs[run.config] }; });
const configOf = (run) => run.snapshot || configs[run.config];
let currentView = 'code';
let activeFile = 'src/train.py';
let opened = ['src/train.py', 'configs/baseline.yaml'];
let activeRun = 18;
let selectedRun = 18;
let detailTab = 'overview';
let panelTab = 'logs';
let panelOpen = true;
let panelHeight = 211;
let filter = 'all';
let runQuery = '';
let comparison = false;
let checked = new Set();
let editor = null;
let dark = false;
let toastTimer;
let mobileOpen = false;
let selectedDiff = 'src/train.py';
const themeCompartment = new Compartment();
function editorTheme() {
  const highlight = HighlightStyle.define([
    { tag: [tags.keyword, tags.controlKeyword], color: dark ? '#d49ba9' : '#a34f6a' },
    { tag: tags.string, color: dark ? '#a5c5a5' : '#547d51' },
    { tag: tags.number, color: dark ? '#d4b986' : '#9b6a35' },
    { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: dark ? '#a5c6d8' : '#497797' },
    { tag: tags.comment, color: dark ? '#8c9c90' : '#8a978c', fontStyle: 'italic' },
    { tag: tags.meta, color: '#8f9d91' },
    { tag: tags.typeName, color: dark ? '#c5c59b' : '#687a51' },
  ]);
  return [EditorView.theme({ '&': { color: dark ? '#d9e1db' : '#38423b', backgroundColor: dark ? '#222725' : '#fff' }, '.cm-cursor': { borderLeftColor: dark ? '#bcdac4' : '#3b6a4c' } }, { dark }), syntaxHighlighting(highlight)];
}
function dirty(file) { return files[file] !== saved[file]; }
function updateStatus() {
  $('#save-status').innerHTML = dirty(activeFile) ? '<span class="warning">' + icon('Circle') + '</span>未保存' : '<i class="status-dot"></i>已保存';
  $('#language-status').textContent = activeFile.endsWith('.py') ? 'Python' : activeFile.endsWith('.yaml') ? 'YAML' : activeFile.endsWith('.json') ? 'JSON' : 'Text';
  const running = runs.filter((run) => run.status === 'running');
  $('#task-label').textContent = running.length ? '实验运行中 ' + running.length : '后台任务 0';
  $('#tasks-status').classList.toggle('success', running.length > 0);
  $('#change-count').textContent = Object.keys(tracked).filter((file) => files[file] !== tracked[file]).length;
}
function toast(text) {
  clearTimeout(toastTimer); $('#toast').innerHTML = icon('CircleCheck') + '<span>' + esc(text) + '</span>'; $('#toast').classList.remove('hidden');
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 3400);
}
function saveCurrent() {
  saved[activeFile] = files[activeFile]; updateStatus(); renderDocumentTabs(); renderResource(); toast('已保存到示例会话，未写入磁盘');
}
function mountEditor() {
  if (editor) editor.destroy();
  const extensions = [lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(), bracketMatching(), indentOnInput(), keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]), themeCompartment.of(editorTheme()), EditorView.updateListener.of((update) => {
    states.set(activeFile, update.state);
    if (update.docChanged) { files[activeFile] = update.state.doc.toString(); updateStatus(); renderDocumentTabs(); }
    if (update.selectionSet || update.docChanged) { const head = update.state.selection.main.head; const line = update.state.doc.lineAt(head); $('#cursor-status').textContent = 'Ln ' + line.number + ', Col ' + (head - line.from + 1); }
  })];
  if (activeFile.endsWith('.py')) extensions.push(python());
  else if (activeFile.endsWith('.json')) extensions.push(javascript());
  let state = states.get(activeFile);
  if (!state) state = EditorState.create({ doc: files[activeFile], extensions });
  editor = new EditorView({ state, parent: $('#editor-host') });
  editor.dispatch({ effects: themeCompartment.reconfigure(editorTheme()) });
  const ext = activeFile.endsWith('.py') ? 'Python' : '文本';
  editor.contentDOM.setAttribute('aria-label', activeFile + ' ' + ext + '编辑器');
}
function setView(view) {
  if (editor) { states.set(activeFile, editor.state); editor.destroy(); editor = null; }
  currentView = view; comparison = false; mobileOpen = false;
  document.querySelectorAll('[data-view]').forEach((tab) => { const active = tab.dataset.view === view; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); });
  renderResource(); renderMain(); updateStatus();
}
function folderHtml(name, depth = 0) {
  return '<button class="folder-row ' + (folds[name] ? '' : 'closed') + '" style="padding-left:' + (13 + depth * 15) + 'px" data-folder="' + name + '" aria-expanded="' + String(folds[name]) + '"><span class="chevron">' + icon('ChevronDown') + '</span>' + icon('Folder') + '<span>' + name.split('/').pop() + '</span></button>';
}
function fileHtml(file, root = false, depth = 0) {
  const name = file.split('/').pop(); const style = root ? '' : ' style="padding-left:' + (46 + depth * 15) + 'px"';
  const cls = file.endsWith('.py') ? 'python' : file.endsWith('.yaml') ? 'yaml' : file.endsWith('.csv') ? 'data-file' : '';
  return '<button class="file-row ' + (root ? 'root-file ' : '') + (file === activeFile ? 'active' : '') + '" data-file="' + file + '"' + style + '><span class="' + cls + '">' + icon(file.endsWith('.py') ? 'FileCode2' : file.endsWith('.yaml') ? 'FileCog' : 'FileText') + '</span><span>' + esc(name) + '</span>' + (tracked[file] !== undefined && files[file] !== tracked[file] ? '<span class="git-state">M</span>' : '') + (dirty(file) ? '<span class="warning">•</span>' : '') + '</button>';
}
function renderResource() {
  const root = $('#resource'); root.classList.toggle('mobile-open', mobileOpen);
  if (currentView === 'code') {
    let tree = '';
    for (const name of ['src', 'configs', 'data', 'outputs']) {
      tree += folderHtml(name);
      if (folds[name]) {
if (name === 'outputs') { for (const directory of [...new Set(Object.keys(files).filter((file) => file.startsWith('outputs/')).map((file) => file.split('/').slice(0, 2).join('/')))]) { tree += folderHtml(directory, 1); if (folds[directory]) tree += Object.keys(files).filter((file) => file.startsWith(directory + '/')).map((file) => fileHtml(file, false, 1)).join(''); } }
        else tree += Object.keys(files).filter((file) => file.startsWith(name + '/')).map((file) => fileHtml(file)).join('');
      }
    }
    tree += fileHtml('README.md', true) + fileHtml('requirements.txt', true);
    root.innerHTML = '<div class="resource-head"><strong>文件</strong><span class="spacer"></span>' + btn('ChevronsDownUp', 'collapse-folders', '折叠文件夹') + '</div><div class="search-wrap">' + icon('Search') + '<input id="file-search" aria-label="筛选文件名" placeholder="筛选文件名…"></div><div class="repo-caption">' + icon('ChevronDown') + 'TABULAR-BASELINE</div><div class="tree" id="file-tree">' + tree + '</div><div class="sidebar-bottom"><div class="branch-row">' + icon('GitBranch') + '<span class="mono">experiment/baseline</span><span class="spacer"></span><span class="warning">2 M</span></div><p class="root-path">./research/tabular-baseline</p></div>';
    $('#file-search').addEventListener('input', (event) => {
      const query = event.target.value.toLowerCase(); $('#file-tree').innerHTML = query ? Object.keys(files).filter((file) => file.toLowerCase().includes(query)).map((file) => fileHtml(file, true)).join('') || '<p class="filter-empty">未找到文件</p>' : tree;
    });
  } else if (currentView === 'runs') {
    const running = runs.filter((run) => run.status === 'running').length;
    root.innerHTML = '<div class="resource-head"><strong>运行记录</strong><span class="spacer"></span><span class="count">' + runs.length + '</span></div>' + [['all', '全部运行', 'Layers3', runs.length], ['running', '运行中', 'LoaderCircle', running], ['success', '已完成', 'CircleCheck', runs.filter((run) => run.status === 'success').length], ['cancelled', '已取消', 'CircleStop', runs.filter((run) => run.status === 'cancelled').length]].map(([key, text, name, count]) => '<button class="run-filter ' + (filter === key ? 'active' : '') + '" data-filter="' + key + '">' + icon(name) + text + '<span class="spacer"></span><span class="count">' + count + '</span></button>').join('') + '<p class="resource-section-label">实验分组</p><div class="group-row">' + icon('Folder') + '基线与消融</div><span class="spacer"></span><div class="sidebar-bottom muted">表格分类 · 基线复现<br><p class="root-path">结果按每次运行独立保存</p></div>';
  } else {
    root.innerHTML = '<div class="resource-head"><strong>代码变更</strong><span class="spacer"></span>' + btn('RefreshCw', 'refresh-changes', '刷新变更') + '</div><div class="change-summary"><div class="change-count">' + icon('GitBranch') + '<span class="mono">experiment/baseline</span></div>与工作区基准比较<br><span class="mono">a92f3b7</span></div><div class="repo-caption">未提交变更 <span class="count">2</span></div><div class="tree">' + Object.keys(tracked).map((file) => '<button class="file-row root-file ' + (selectedDiff === file ? 'active' : '') + '" data-diff="' + file + '">' + icon('FileDiff') + '<span>' + file.split('/').pop() + '</span><span class="git-state">M</span></button>').join('') + '</div><div class="sidebar-bottom muted">本视图审阅变更，不自动提交。<p class="root-path">2 个文件 · 工作区修改</p></div>';
  }
}
function renderDocumentTabs() {
  const tabs = $('#document-tabs'); if (!tabs) return;
  tabs.innerHTML = opened.map((file) => '<button class="document-tab ' + (file === activeFile ? 'active' : '') + '" data-file="' + file + '" role="tab" aria-selected="' + (file === activeFile) + '">' + icon(file.endsWith('.py') ? 'FileCode2' : 'FileCog') + esc(file.split('/').pop()) + (dirty(file) ? '<span class="unsaved"></span>' : '') + '<span class="close-tab" data-close-file="' + file + '" role="button" aria-label="关闭 ' + file.split('/').pop() + '">' + icon('X') + '</span></button>').join('');
}
function renderMain() {
  const main = $('#main');
  if (currentView === 'code') {
    main.innerHTML = '<section class="code-pane"><div class="document-tabs" id="document-tabs" role="tablist" aria-label="打开的文件"></div><div class="editor-context"><span>' + esc(activeFile.split('/').slice(0, -1).join('/') || 'tabular-baseline') + '</span><span class="separator">›</span><span>' + esc(activeFile.split('/').pop()) + '</span><span class="spacer"></span><span class="branch">' + icon('GitBranch') + '工作区</span>' + btn('PanelBottom', 'panel', panelOpen ? '收起运行输出，任务继续运行' : '打开运行输出') + '</div><div class="editor-host" id="editor-host"></div></section><section id="log-panel" class="log-panel ' + (panelOpen ? '' : 'hidden') + '" style="height:' + panelHeight + 'px"><div class="resize-grip" id="resize-grip" role="separator" tabindex="0" aria-label="调整输出面板高度" aria-orientation="horizontal"></div><div class="panel-bar"><button class="panel-tab ' + (panelTab === 'logs' ? 'active' : '') + '" data-panel="logs">运行输出</button><button class="panel-tab ' + (panelTab === 'problems' ? 'active' : '') + '" data-panel="problems">问题 <span class="count">0</span></button><button class="panel-tab ' + (panelTab === 'artifacts' ? 'active' : '') + '" data-panel="artifacts">产物 <span class="count">2</span></button><span class="spacer"></span>' + btn('ChevronsUpDown', 'panel-expand', '展开或还原输出面板') + btn('X', 'panel', '隐藏日志，任务继续运行') + '</div><div class="log-toolbar" id="log-toolbar"></div><div class="log-content" id="log-content"></div></section>';
    renderDocumentTabs(); mountEditor(); renderLog(); initResizer();
  } else if (currentView === 'runs') renderRuns(); else renderDiff();
}
function openFile(file) {
  if (!(file in files)) return;
  if (editor) { states.set(activeFile, editor.state); editor.destroy(); editor = null; }
  activeFile = file; if (!opened.includes(file)) opened.push(file); mobileOpen = false;
  if (currentView !== 'code') setView('code'); else { renderResource(); renderMain(); updateStatus(); }
}
function stateHtml(run) {
  if (run.status === 'running') return '<span class="run-state success">' + icon('LoaderCircle').replace('<svg ', '<svg class="spin" ') + '运行中</span>';
  if (run.status === 'cancelled') return '<span class="run-state muted">' + icon('CircleStop') + '已取消</span>';
  return '<span class="run-state success">' + icon('CircleCheck') + (run.manual ? '已记录' : '已完成') + '</span>';
}
function selected() { return runs.find((run) => run.id === selectedRun) || runs[0]; }
function live() { return runs.find((run) => run.id === activeRun) || runs[0]; }
function artifactsHtml(run) {
  if (run.manual) return '<p class="muted">手动记录未自动采集产物。</p>';
  if (run.status !== 'success') return '<p class="muted">' + (run.status === 'running' ? '运行尚未结束，产物将在写入后出现。' : '此次运行已取消，尚未写入结果文件。') + '</p>';
  return ['metrics.json', 'confusion_matrix.csv'].map((name) => '<div class="artifact-row">' + icon(name.endsWith('.json') ? 'FileJson' : 'Table2') + '<span>outputs/run-' + String(run.id).padStart(3, '0') + '/' + name + '</span><span class="spacer"></span><button class="small-action" data-artifact-file="outputs/run-' + String(run.id).padStart(3, '0') + '/' + name + '">打开</button></div>').join('');
}
function logHtml(run) { return run.logs.map(([time, text, className]) => '<div class="log-row ' + (className || '') + '"><span class="log-time">' + esc(time) + '</span><span>' + esc(text) + '</span></div>').join(''); }
function renderLog() {
  if (!$('#log-toolbar')) return; const run = live();
  $('#log-toolbar').innerHTML = '<span class="run-id">#' + String(run.id).padStart(3, '0') + '</span><span>' + esc(run.name) + '</span>' + stateHtml(run) + '<span class="log-command">' + esc(configOf(run).command) + '</span><span class="spacer"></span>' + (run.status === 'running' ? '<button class="text-btn outlined" data-stop="' + run.id + '">' + icon('Square') + '停止</button>' : '<span class="muted mono">' + run.duration + '</span>') + '<button class="small-action" data-run-detail="' + run.id + '">查看详情 ' + icon('ArrowUpRight') + '</button>';
  const content = $('#log-content');
  content.innerHTML = panelTab === 'logs' ? logHtml(run) : panelTab === 'artifacts' ? artifactsHtml(run) : '<p class="muted">此次示例运行未报告诊断问题。退出状态并不代表科研结论成立。</p>';
  if (panelTab === 'logs') content.scrollTop = content.scrollHeight;
}
function renderRuns() {
  if (comparison) { renderComparison(); return; }
  const visibleRuns = runs.filter((run) => (filter === 'all' || run.status === filter) && (run.name + run.id).toLowerCase().includes(runQuery.toLowerCase()));
  $('#main').innerHTML = '<section class="runs-main"><div class="runs-toolbar"><strong style="font-size:12px;font-weight:500">' + visibleRuns.length + ' 条记录</strong><input id="run-search" aria-label="搜索运行" placeholder="搜索名称或编号…" value="' + esc(runQuery) + '"><span class="spacer"></span><button class="text-btn outlined" data-action="compare" ' + (checked.size < 2 ? 'disabled' : '') + '>' + icon('Columns3') + '比较' + (checked.size ? ' (' + checked.size + ')' : '') + '</button><button class="text-btn" data-action="manual-record">' + icon('Plus') + '手动记录</button></div><div class="run-table-wrap"><table aria-label="实验运行记录"><thead><tr><th></th><th>运行 / 配置</th><th>状态</th><th class="time-col">开始时间</th><th>用时</th><th class="metric-col">Macro-F1</th><th class="source-col">来源</th></tr></thead><tbody>' + visibleRuns.map((run) => '<tr data-select-run="' + run.id + '" class="' + (selectedRun === run.id ? 'selected' : '') + '"><td><input type="checkbox" data-check-run="' + run.id + '" aria-label="选择运行 ' + run.id + ' 进行比较" ' + (checked.has(run.id) ? 'checked' : '') + '></td><td><div class="name-cell"><strong>' + esc(run.name) + '</strong><small>#' + String(run.id).padStart(3, '0') + ' · configs/' + run.config + '.yaml</small></div></td><td>' + stateHtml(run) + '</td><td class="time-col mono">' + run.time + '</td><td class="mono">' + run.duration + '</td><td class="metric-col mono">' + (run.metric === null ? '—' : run.metric.toFixed(4)) + '</td><td class="source-col muted">' + run.source + '</td></tr>').join('') + '</tbody></table>' + (!visibleRuns.length ? '<p class="filter-empty">没有匹配的运行记录</p>' : '') + '</div><section id="run-detail" class="detail"></section></section>';
  $('#run-search').addEventListener('input', (event) => { runQuery = event.target.value; const position = event.target.selectionStart; renderRuns(); $('#run-search').focus(); $('#run-search').setSelectionRange(position, position); });
  renderDetail();
}
function renderDetail() {
  const run = selected(); if (!$('#run-detail')) return;
  $('#run-detail').innerHTML = '<div class="detail-heading"><h2>' + esc(run.name) + '</h2><span class="muted mono">#' + String(run.id).padStart(3, '0') + '</span>' + stateHtml(run) + '<span class="spacer"></span>' + (run.status === 'running' ? '<button class="text-btn outlined" data-stop="' + run.id + '">' + icon('Square') + '停止</button>' : '<button class="text-btn outlined" data-rerun="' + run.id + '">' + icon('RotateCcw') + '再次运行</button>') + '</div><div class="detail-tabs">' + [['overview', '概览'], ['params', '参数与环境'], ['logs', '日志'], ['artifacts', '产物'], ['conclusion', '结论']].map(([key, text]) => '<button class="' + (detailTab === key ? 'active' : '') + '" data-detail="' + key + '">' + text + '</button>').join('') + '</div><div class="detail-body" id="detail-body"></div>';
  const rows = detailTab === 'params' ? [['数据集', 'data/sample.csv · 示例数据'], ['评价协议', 'StratifiedKFold · 5-fold · seed=42'], ['正则化 C', run.C], ['特征处理', run.scaler], ['Python', run.manual ? '未采集' : '.venv / Python 3.12.7'], ['依赖快照', run.manual ? '未采集' : 'scikit-learn 1.5.2 · pandas 2.2.3'], ['运行命令', run.manual ? '未执行（手动记录）' : configOf(run).command]] : [['运行配置', run.manual ? '手动记录，未关联配置' : configOf(run).name], ['启动命令', run.manual ? '未执行（手动记录）' : configOf(run).command], ['工作目录', './research/tabular-baseline'], ['代码来源', run.commit], ['结果位置', './outputs/run-' + String(run.id).padStart(3, '0')], ['退出码', run.manual ? '不适用（手动记录）' : run.status === 'running' ? '运行中，尚未产生' : run.status === 'cancelled' ? '用户取消' : '0'], ['Macro-F1', run.metric === null ? '尚未记录' : run.metric.toFixed(4)]];
  $('#detail-body').innerHTML = detailTab === 'logs' ? '<div class="log-content" style="padding:0">' + logHtml(run) + '</div>' : detailTab === 'artifacts' ? artifactsHtml(run) : detailTab === 'conclusion' ? '<div class="detail-note" style="margin-top:0;border:0;padding-top:0"><h3>结果解释与下一步</h3><textarea id="conclusion-input" aria-label="运行结论">' + esc(run.conclusion || '') + '</textarea><button class="text-btn outlined" data-action="save-conclusion" style="margin-top:10px">' + icon('Save') + '保存结论</button></div>' : '<dl class="definition-grid">' + rows.map(([key, value]) => '<dt>' + key + '</dt><dd class="' + (key === '运行配置' || key === '数据集' ? '' : 'mono') + '">' + esc(value) + '</dd>').join('') + '</dl>' + (detailTab === 'overview' ? '<section class="detail-note"><h3>结果解释与下一步</h3><p>' + esc(run.conclusion || '尚未记录研究结论。') + '</p></section>' : '');
}
function renderComparison() {
  const compared = runs.filter((run) => checked.has(run.id));
  const dimensions = [['数据集', () => 'sample.csv'], ['评价协议', () => '5-fold · seed=42'], ['正则化 C', (run) => run.C], ['特征处理', (run) => run.scaler], ['Macro-F1', (run) => run.metric === null ? '未记录' : run.metric.toFixed(4)], ['Accuracy', (run) => run.accuracy === null ? '未记录' : run.accuracy.toFixed(4)], ['代码来源', (run) => run.commit]];
  $('#main').innerHTML = '<div class="runs-toolbar"><button class="text-btn outlined" data-action="compare-back">' + icon('ArrowLeft') + '返回运行记录</button><span class="spacer"></span><span class="muted" style="font-size:11px">' + compared.length + ' 条 · 基线与消融</span></div><section class="comparison"><h2>运行比较</h2><table aria-label="运行比较"><thead><tr><th>比较维度</th>' + compared.map((run) => '<th>' + esc(run.name) + '<br><span class="muted mono">#' + run.id + '</span></th>').join('') + '</tr></thead><tbody>' + dimensions.map(([name, get]) => '<tr><td>' + name + '</td>' + compared.map((run) => '<td class="mono">' + esc(get(run)) + '</td>').join('') + '</tr>').join('') + '</tbody></table><p class="note">这些记录使用相同的示例数据与划分。单次分数差异不能证明显著改进；请结合不同随机种子及评价协议判断。所有指标均为虚构设计数据。</p></section>';
}
function renderDiff() {
  const previous = tracked[selectedDiff].split('\n'); const next = files[selectedDiff].split('\n');
  let changeIndex = selectedDiff.endsWith('.py') ? 22 : 5;
  const start = Math.max(0, changeIndex - 9); const end = Math.min(Math.max(previous.length, next.length), changeIndex + 12);
  const lines = (source, other, name) => source.slice(start, end).map((line, offset) => '<div class="diff-line ' + (line !== other[start + offset] ? name : '') + '"><span class="diff-num">' + (start + offset + 1) + '</span><span class="diff-marker">' + (line !== other[start + offset] ? name === 'removed' ? '−' : '+' : ' ') + '</span><span>' + esc(line) + '</span></div>').join('');
  $('#main').innerHTML = '<div class="diff-header">' + icon('FileDiff') + '<strong class="mono" style="font-weight:500">' + selectedDiff + '</strong><span class="spacer"></span><span class="success mono">+1</span><span class="danger mono">−1</span><button class="text-btn outlined" data-file="' + selectedDiff + '">' + icon('FileCode2') + '打开文件</button></div><div class="diff-grid"><section class="diff-side old"><div class="diff-label">' + icon('GitCommitHorizontal') + '基准 · a92f3b7</div><div class="diff-lines">' + lines(previous, next, 'removed') + '</div></section><section class="diff-side"><div class="diff-label">' + icon('Pencil') + '当前工作区 · 未提交</div><div class="diff-lines">' + lines(next, previous, 'added') + '</div></section></div>';
}
function updateTaskViews() {
  updateStatus();
  if (currentView === 'code') renderLog();
  if (currentView === 'runs') { if (comparison) renderComparison(); else renderRuns(); }
  if ($('#tasks-dialog').open) renderTasks();
}
function startRun(configKey = $('#config-select').value, snapshot = configs[configKey]) {
  const id = Math.max(...runs.map((run) => run.id)) + 1;
  const run = { id, snapshot: { ...snapshot }, name: configKey === 'baseline' ? 'baseline · C=1.0' : 'ablation · no scaler', config: configKey, status: 'running', time: new Date().toLocaleTimeString('en-GB'), duration: '00:00', metric: null, accuracy: null, source: '手动启动', C: '1.0', scaler: configKey === 'baseline' ? 'StandardScaler' : 'None', commit: 'a92f3b7 + 当前文件快照（示例）', conclusion: '', logs: [], progress: 0 };
  if (Object.keys(files).some(dirty)) { toast('存在未保存编辑；此示例运行使用已保存版本'); }
  runs.unshift(run); activeRun = id; selectedRun = id; panelOpen = true; panelTab = 'logs';
  run.logs.push([run.time, '[START] ' + snapshot.command, 'muted']);
  if (currentView === 'code') { const panel = $('#log-panel'); panel.classList.remove('hidden'); renderLog(); } else if (currentView === 'runs') { renderResource(); renderRuns(); }
  updateStatus(); toast('模拟运行 #' + id + ' 已启动；切换视图不会停止');
  const messages = ['[INFO] Using .venv / Python 3.12.7', '[INFO] Loaded sample.csv: 1,000 rows, 12 features', '[INFO] Evaluating fold 1/5', '[INFO] Evaluating fold 2/5', '[INFO] Evaluating fold 3/5', '[INFO] Evaluating fold 4/5', '[INFO] Evaluating fold 5/5', '[SAVE] outputs/run-' + String(id).padStart(3, '0') + '/metrics.json'];
  run.timer = setInterval(() => {
    if (run.status !== 'running') { clearInterval(run.timer); return; }
    run.progress += 1; run.duration = '00:' + String(run.progress).padStart(2, '0');
    const time = new Date().toLocaleTimeString('en-GB');
    if (run.progress <= messages.length) run.logs.push([time, messages[run.progress - 1], '']);
    else {
      run.status = 'success'; run.metric = configKey === 'baseline' ? 0.8342 : 0.8060; run.accuracy = configKey === 'baseline' ? 0.8510 : 0.8290;
      run.logs.push([time, '[DONE] Simulated process exited with code 0', 'success']);
      run.conclusion = '模拟运行完成。请查看配置、日志与产物，记录自己的解释。'; clearInterval(run.timer);
      const directory = 'outputs/run-' + String(run.id).padStart(3, '0');
      files[directory + '/metrics.json'] = JSON.stringify({ f1_macro: run.metric, accuracy: run.accuracy, source: 'fictional_design_fixture' }, null, 2);
      files[directory + '/confusion_matrix.csv'] = files['outputs/run-018/confusion_matrix.csv'];
      saved[directory + '/metrics.json'] = files[directory + '/metrics.json'];
      saved[directory + '/confusion_matrix.csv'] = files[directory + '/confusion_matrix.csv'];
      if (currentView === 'code') renderResource();
      if (currentView === 'runs') renderResource(); toast('模拟运行 #' + id + ' 完成，结果已保留');
    }
    updateTaskViews();
  }, 950);
}
function stopRun(id) {
  const run = runs.find((entry) => entry.id === Number(id)); if (!run || run.status !== 'running') return;
  clearInterval(run.timer); run.status = 'cancelled'; run.logs.push([new Date().toLocaleTimeString('en-GB'), '[STOP] Simulated run cancelled by user', 'muted']); renderResource(); updateTaskViews(); toast('模拟运行 #' + run.id + ' 已取消，日志保留');
}
function renderTasks() {
  const active = runs.filter((run) => run.status === 'running');
  $('#tasks-list').innerHTML = active.length ? active.map((run) => '<div class="task-row">' + icon('LoaderCircle') + '<div><strong>#' + run.id + ' · ' + esc(run.name) + '</strong><p>表格分类 · 基线复现 · ' + run.duration + '</p></div><span class="spacer"></span><button class="small-action" data-stop="' + run.id + '">停止</button><button class="small-action" data-run-detail="' + run.id + '">打开</button></div>').join('') : '<p class="muted" style="font-size:12px">没有正在运行的任务。运行记录保留在 Runs。</p>';
}
function openConfig() {
  const config = configs[$('#config-select').value]; $('#config-name').value = config.name; $('#config-command').value = config.command; $('#config-cwd').value = config.cwd; $('#config-output').value = config.output; $('#config-environment').value = config.environment; $('#config-dialog').showModal();
}
$('#config-form').addEventListener('submit', (event) => {
  event.preventDefault(); const key = $('#config-select').value; configs[key] = { name: $('#config-name').value.trim(), command: $('#config-command').value.trim(), cwd: $('#config-cwd').value.trim(), output: $('#config-output').value.trim(), environment: $('#config-environment').value }; $('#config-select option[value="' + key + '"]').textContent = configs[key].name; $('#config-dialog').close(); toast('运行配置已保存在示例会话');
});
$('#record-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = Math.max(...runs.map((run) => run.id)) + 1;
  runs.unshift({ id, name: $('#record-name').value.trim(), config: 'baseline', manual: true, status: 'success', time: new Date().toLocaleTimeString('en-GB'), duration: '—', metric: $('#record-metric').value === '' ? null : Number($('#record-metric').value), accuracy: null, source: '手动记录', C: $('#record-parameter').value || '未记录', scaler: '未记录', commit: '未关联代码（手动记录）', conclusion: $('#record-conclusion').value, logs: [['', '[NOTE] Manual record; no process was executed.', 'muted']] });
  selectedRun = id; $('#record-dialog').close(); setView('runs'); toast('手动记录已保存到示例会话');
});
function renderSearch() {
  const query = $('#global-search').value.toLowerCase(); const matches = Object.keys(files).filter((file) => file.toLowerCase().includes(query));
  $('#search-results').innerHTML = matches.map((file) => '<button data-search-file="' + file + '">' + icon('File') + '<span>' + file.split('/').pop() + '</span><span class="filepath">' + file.split('/').slice(0, -1).join('/') + '</span></button>').join('') || '<p class="filter-empty">未找到文件</p>';
}
$('#global-search').addEventListener('input', renderSearch);
function openSearch() { renderSearch(); $('#search-dialog').showModal(); $('#global-search').focus(); }
function initResizer() {
  const grip = $('#resize-grip');
  grip.addEventListener('pointerdown', (event) => {
    const y = event.clientY; const height = $('#log-panel').getBoundingClientRect().height;
    grip.setPointerCapture(event.pointerId);
    const move = (next) => { panelHeight = Math.max(115, Math.min(window.innerHeight * 0.6, height + y - next.clientY)); $('#log-panel').style.height = panelHeight + 'px'; };
    const stop = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', stop); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', stop);
  });
  grip.addEventListener('keydown', (event) => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); panelHeight = Math.max(115, Math.min(window.innerHeight * 0.6, panelHeight + (event.key === 'ArrowUp' ? 20 : -20))); $('#log-panel').style.height = panelHeight + 'px'; } });
}
const actions = {
  save: saveCurrent,
  run: () => startRun(),
  configuration: openConfig,
  environment: () => $('#environment-dialog').showModal(),
  'open-requirements': () => { $('#environment-dialog').close(); openFile('requirements.txt'); },
  'check-environment': () => toast('示例依赖检查通过；未检测本机环境'),
  tasks: () => { renderTasks(); $('#tasks-dialog').showModal(); },
  panel: () => { panelOpen = !panelOpen; $('#log-panel')?.classList.toggle('hidden', !panelOpen); if (!panelOpen) toast('日志已收起，运行状态不受影响'); },
  'panel-expand': () => { panelHeight = panelHeight > 280 ? 211 : Math.min(window.innerHeight * 0.55, 440); $('#log-panel').style.height = panelHeight + 'px'; },
  sidebar: () => { mobileOpen = !mobileOpen; $('#resource').classList.toggle('mobile-open', mobileOpen); },
  'collapse-folders': () => { Object.keys(folds).forEach((key) => folds[key] = false); renderResource(); },
  'refresh-changes': () => { renderResource(); renderDiff(); toast('示例工作区变更已刷新'); },
  compare: () => { if (checked.size >= 2) { comparison = true; renderComparison(); } },
  'compare-back': () => { comparison = false; renderRuns(); },
  'manual-record': () => { $('#record-form').reset(); $('#record-dialog').showModal(); },
  'save-conclusion': () => { selected().conclusion = $('#conclusion-input').value; toast('结论已保存到此条示例运行'); },
  search: openSearch,
  theme: () => { dark = !dark; document.body.classList.toggle('dark', dark); if (editor) editor.dispatch({ effects: themeCompartment.reconfigure(editorTheme()) }); },
  assistant: () => { $('#assistant').classList.toggle('hidden'); },
  'assistant-send': () => { const prompt = $('#assistant-prompt').value.trim(); if (!prompt) return; $('#assistant-messages').innerHTML += '<div class="assistant-bubble user">' + esc(prompt) + '</div><div class="assistant-bubble">这是本地设计示例，未连接模型。实际产品中，本次请求会携带你选择的代码与运行材料。</div>'; $('#assistant-prompt').value = ''; },
  project: () => toast('当前为独立项目示例；未连接项目数据库'),
  'other-view': () => toast('此示例仅展示 Experiments，不跳转真实项目'),
  experiments: () => setView('code'),
  settings: () => $('#environment-dialog').showModal(),
};
document.addEventListener('click', (event) => {
  const closeFile = event.target.closest('[data-close-file]');
  if (closeFile) { event.stopPropagation(); const file = closeFile.dataset.closeFile; if (opened.length <= 1) { toast('保留最后一个编辑标签'); return; } opened = opened.filter((entry) => entry !== file); if (dirty(file)) toast('标签已关闭，未保存编辑仍保留在示例会话'); if (activeFile === file) openFile(opened[opened.length - 1]); else renderDocumentTabs(); return; }
  const close = event.target.closest('[data-close]'); if (close) { $('#' + close.dataset.close).close(); return; }
  const view = event.target.closest('[data-view]'); if (view) { setView(view.dataset.view); return; }
  const folder = event.target.closest('[data-folder]'); if (folder) { folds[folder.dataset.folder] = !folds[folder.dataset.folder]; renderResource(); return; }
  const file = event.target.closest('[data-file]'); if (file) { openFile(file.dataset.file); return; }
  const searched = event.target.closest('[data-search-file]'); if (searched) { $('#search-dialog').close(); openFile(searched.dataset.searchFile); return; }
  const diff = event.target.closest('[data-diff]'); if (diff) { selectedDiff = diff.dataset.diff; renderResource(); renderDiff(); return; }
  const check = event.target.closest('[data-check-run]'); if (check) { const id = Number(check.dataset.checkRun); if (check.checked && checked.size >= 4) { check.checked = false; toast('最多并列比较 4 条运行'); return; } check.checked ? checked.add(id) : checked.delete(id); renderRuns(); return; }
  const run = event.target.closest('[data-select-run]'); if (run) { selectedRun = Number(run.dataset.selectRun); renderRuns(); return; }
  const detail = event.target.closest('[data-detail]'); if (detail) { detailTab = detail.dataset.detail; renderDetail(); return; }
  const panel = event.target.closest('[data-panel]'); if (panel) { panelTab = panel.dataset.panel; document.querySelectorAll('[data-panel]').forEach((tab) => tab.classList.toggle('active', tab.dataset.panel === panelTab)); renderLog(); return; }
  const runFilter = event.target.closest('[data-filter]'); if (runFilter) { filter = runFilter.dataset.filter; renderResource(); renderRuns(); return; }
  const stop = event.target.closest('[data-stop]'); if (stop) { stopRun(stop.dataset.stop); return; }
  const rerun = event.target.closest('[data-rerun]'); if (rerun) { const run = runs.find((entry) => entry.id === Number(rerun.dataset.rerun)); startRun(run.config, configOf(run)); return; }
  const runDetail = event.target.closest('[data-run-detail]'); if (runDetail) { selectedRun = Number(runDetail.dataset.runDetail); if ($('#tasks-dialog').open) $('#tasks-dialog').close(); detailTab = 'overview'; setView('runs'); return; }
  const artifact = event.target.closest('[data-artifact-file]'); if (artifact) { openFile(artifact.dataset.artifactFile); return; }
  const action = event.target.closest('[data-action]'); if (action && actions[action.dataset.action]) actions[action.dataset.action]();
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveCurrent(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); }
  if (event.key === 'Escape') { $('#tooltip').classList.add('hidden'); if ($('#assistant') && !$('#assistant').classList.contains('hidden') && !document.querySelector('dialog[open]')) $('#assistant').classList.add('hidden'); mobileOpen = false; $('#resource').classList.remove('mobile-open'); }
});
let tipTimer;
function showTip(target) {
  const text = target.dataset.tip; if (!text) return;
  clearTimeout(tipTimer); tipTimer = setTimeout(() => {
    const tip = $('#tooltip'); tip.textContent = text; tip.classList.remove('hidden'); const rect = target.getBoundingClientRect(); const width = tip.getBoundingClientRect().width; tip.style.left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left)) + 'px'; tip.style.top = (rect.bottom + 32 < window.innerHeight ? rect.bottom + 6 : rect.top - 31) + 'px';
  }, 350);
}
document.addEventListener('mouseover', (event) => { const target = event.target.closest('[data-tip]'); if (target && !target.contains(event.relatedTarget)) showTip(target); });
document.addEventListener('mouseout', (event) => { const target = event.target.closest('[data-tip]'); if (target && !target.contains(event.relatedTarget)) { clearTimeout(tipTimer); $('#tooltip').classList.add('hidden'); } });
document.addEventListener('focusin', (event) => { if (event.target.dataset.tip) showTip(event.target); });
document.addEventListener('focusout', () => { clearTimeout(tipTimer); $('#tooltip').classList.add('hidden'); });
hydrateIcons(); renderResource(); renderMain(); updateStatus();
