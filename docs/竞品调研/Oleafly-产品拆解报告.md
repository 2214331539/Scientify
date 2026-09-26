# Oleafly 产品拆解报告

> 调研对象：Oleafly（oleafly.com / github.com/Oleafly/Oleafly）
> 版本快照：最新发布 v0.4.1（2026-09-13），仓库开发版本 0.4.2
> 调研时间：2026-09-21
> 调研方式：官网 + 文档站 112 个页面（llms.txt 全量抓取）+ GitHub 仓库与源码清单 + 发布/下载/星标等公开指标

---

## 0. 摘要：先把结论摆出来

1. **Oleafly 不是"又一个 LaTeX 编辑器"，而是把科研写作从"工具链拼装"变成"一个本地工作台"。**它把编辑器、编译器、PDF、文献引用、图表、Git、校验（Preflight）、可选 AI 全部收进同一个桌面应用，并以普通文件夹作为数据边界。
2. **它的第一性原理是"反云"：文件归用户、无账号、无遥测、无订阅。** 这条原则不是营销话术，而是贯穿到架构（本地 sidecar 编译、密钥本地加密、Git 而非自建云）、定价（永久免费、AGPL-3.0）和路线图（协作"Coming soon"）的工程决策。
3. **它的产品哲学是"AI 可选、可审阅、可拒绝"。** 用户可完全不用 AI；用了以后有 4 档审批模式、计划先审、内联 diff、隔离副本上的 Research Tasks、用量与预算。这是它与"AI 帮你写作"类产品最本质的分野。
4. **它的护城河不是 AI，而是"本地工具链 + 工程可靠性"。** Tectonic/Biber/Typst/Pandoc 全部版本固定、校验和绑定、CI 同源构建；编译可取消、超时可杀进程树、最新优先队列、结果带身份防错配。这些是做云端编辑器的人不愿意投入的脏活。
5. **它的增长引擎是 SEO 内容矩阵，而不是产品内裂变。** 19 篇学科/迁移/工作流博客 + 37 个工具页 + 122 个模板 + 12 个语言版本的落地页 + 一份多产品对比表，构成非常典型的"搜索流量 → 下载"漏斗。
6. **它有一个学术产品独有的增长闭环：请用户在论文里引用自己。** 应用内提供 Oleafly 的 BibTeX，并能一键写入当前论文参考文献。软件即被引用物，引用即长期曝光。
7. **它目前绝对体量还很小，但运营密度极高。** 首发至今约 2.5 个月：171 star / 20 fork / 2290 次安装包下载 / 11 个开放 issue / 18 个开放 PR / 至少 9 个公开发布版本。
8. **它的成本结构被刻意做薄了。** 没有自建云、没有托管推理、没有账号体系，AI 账单由用户自己付给模型厂商；主要成本是 CDN（截图/字体/模板包）、更新源和开发人力。
9. **它的商业模式是空白，这既是最大优势也是最大风险。** 无变现入口 → 获取信任成本极低；但长期需要靠个人/社区维持一个跨三平台、带签名发布与自动更新的桌面产品。
10. **对 Scientify 而言：Oleafly 是"写作与出版闭环"的标杆，不是可以直接对标的战场。** 值得抄的是它的工程诚实、AI 审批模型、隔离任务、文档与增长体系；不该正面硬碰的是 LaTeX 编译链、模板生态和 preflight 校验深度。

---

## 1. 产品概况

### 1.1 基本档案

| 维度 | 事实 |
|---|---|
| 产品名 | Oleafly（官网 oleafly.com） |
| 一句话定位 | 免费、开源、local-first 的科研写作工作台（LaTeX / Typst / Markdown） |
| 品类归属 | 桌面科研写作与出版工作台；与 Overleaf（云 LaTeX）、VS Code + LaTeX Workshop（DIY 栈）、TeXstudio（传统 IDE）、Typst App 正面竞争 |
| 首个公开版本 | 2026-07 初（仓库创建于 2026-07-05） |
| 当前版本 | v0.4.1（2026-09-13 发布），仓库主线 0.4.2 |
| 许可 | AGPL-3.0-or-later（应用与全部前端包） |
| 平台 | macOS Apple Silicon、Windows x64、Linux x64/ARM64（无 Intel Mac / Windows ARM 原生包） |
| 作者 | Prajwal S. Venkateshmurthy（个人 / 独立研究者，Cargo 中署名 "Prajwal Murthy and contributors"） |
| 组织形态 | GitHub 组织 Oleafly，另有 Oleafly/template-packs 模板仓库 |
| 公开指标 | 171 star、20 fork、11 开放 issue、18 开放 PR、2290 次安装包下载、仓库体积约 149 MB |
| 文档规模 | 文档站 112 个页面，单一 llms.txt 索引，英文 + 简体中文应用界面；官网 12+ 语言落地页 |
| 数据边界 | 项目 = `~/.oleafly/projects/<id>/` 普通文件夹；应用配置与密钥在 `~/.oleafly/` 下加密存储 |

### 1.2 产品自我定义的三条主线

官方文档《Why we build Oleafly》把价值主张压缩成四句话，实际可归为三条主线：

1. **Own the source（拥有源码）**：稿件是 `.tex/.typ/.md/.bib` 普通文件，随时可以被别的编辑器打开、被 Git 管理、被复制走。
2. **Write without an account（无账号写作）**：编辑器、编译、文献工具都不需要 Oleafly 账号，也没有订阅。
3. **Bring help when you need it（按需引入帮助）**：AI 只是"可选的一只手"——接 API、跑本地模型、或直接用已装的 CLI agent；任务是"有边界的"，结果是"要审阅的"。

外加一条隐性主线：**Keep recovery close（把恢复能力放在手边）**——每次成功编译自动存 checkpoint，Git 是产品内建能力而非外挂。

### 1.3 产品形态的演化线索

从文档与仓库结构能看出产品在 2 个多月内的重心迁移：

- **v0.3.x：把编辑器与编译链做扎实**（Tectonic 内置、SyncTeX、PDF 预览、Git、checkpoint）。
- **v0.4.x：把"研究"与"校验"补齐**（37 个工具、Preflight 六项检查、双引擎文献检索、Research Tasks、Skills、MCP 双向连接、简体中文界面）。

也就是说，它的路径是"**先能写 → 再能查 → 再能验 → 最后交给 agent 做**"，而不是"先做 AI 再补功能"。

---

## 2. 目标用户与场景

### 2.1 用户分层

| 层 | 典型画像 | Oleafly 对他们的吸引力 |
|---|---|---|
| 学生（本科/硕士） | 第一次写实验报告、学位论文、简历 | 不用装 TeX、有模板、有 ATS 检查、免费 |
| 博士/博后 | 多年长稿、多章、多文件、导师反馈循环 | 多文件索引、checkpoint + Git、离线可用 |
| 独立研究者 | 没有机构订阅，自付工具费 | 免费且功能完整，AI 可自带 key 或本地模型 |
| PI / 课题组 | 关心可复现、隐私、投稿合规 | 文件自持、Git 协作、Preflight、无遥测 |
| 非英语母语研究者 | 写作语言与界面语言不同 | 界面语言/校对语言/稿件语言三者解耦 |
| 医学科研/基金写作 | 草稿敏感、需审计轨迹 | 本地存储、离线编译、真实 Git 历史 |
| 工业界技术写作 | 简历、白皮书、技术报告 | 同一套工作台兼做简历与技术文档 |

### 2.2 核心 JTBD（用户想完成的事）

| 用户任务 | Oleafly 给出的解法 |
|---|---|
| "我要尽快看到第一份 PDF" | 模板 → 写几行 → Ctrl+Enter 编译，内置引擎无需配置 |
| "我要为一句话找到文献" | 划段 → From document 扫引 → 阈值排序 → 一键入 .bib 并插入 `\cite` |
| "我要修好这个编译错误" | 日志解析 + 编辑器内 squiggle + 让助手读 `get_log` 修 |
| "我要一张能被期刊接受的图" | Diagram Composer 画 TikZ / AI 生成 TikZ → 独立编译预览 → 插入为可编辑源码 |
| "我要投稿前不翻车" | Preflight 六项检查（编译布局/投稿/ATS/无障碍/引用资产/隐私盲审） |
| "我要让 agent 干活但别弄乱我的稿子" | Research Tasks 在隔离副本上跑，逐文件 diff 后选择性 apply |
| "我要能回到上周的版本" | 每次成功编译自动 checkpoint + 命名 Git 提交 |
| "我要换一台电脑继续写" | 项目就是文件夹 + GitHub sync（push/pull） |

### 2.3 场景清单（模板与工作流覆盖）

官方 Workflows 覆盖：研究闭环、研究论文、学位论文、数据分析、简历、审稿与投稿；模板覆盖 23 个内置（论文/学位论文/书/Beamer/海报/简历/作业/通讯/日历/信函）+ 11 个可下载包共 99 个，合计 122 个起点。

值得注意的是它把"**简历**"当成一等公民（ATS 检查、三种模板、Parser 抽取预览）。这是一个高搜索量、低门槛、且天然带来非学术用户的引流场景。

---

## 3. 价值主张与竞争定位

### 3.1 定位公式

> 对**用 LaTeX/Typst/Markdown 写科研文档的人**，
> 他们**被"编辑器 + 编译器 + PDF 阅读器 + 文献管理器 + 画图工具 + Git + AI 聊天窗口"这套拼接流程折磨**，
> Oleafly 是一个**把这些收拢到一个本地桌面应用里的免费工作台**，
> 与 Overleaf/TeXstudio/DIY 栈不同，它**不要求上传稿件、不要求账号、不要求装 TeX，也不强制用 AI**。

### 3.2 它在"反对"什么

从官网对比表与博客标题看，Oleafly 的叙事是明确的三角对抗：

- **反对云编辑器的"信任税"**：数据托管、免费额度（协作人数、编译时长、历史版本、AI 次数）、导出与 fork 的限制。
- **反对 DIY 栈的"配置税"**：装 TeX Live、配 latexmk recipe、装扩展、自己拼 Git 与引用工具。
- **反对"AI 编辑器"的"失控感"**：不让你看 diff 就改稿、把未验证的引用/结论写进论文。

它给出的第三条路是："**guided workspace without proprietary format**"（有引导的工作台，但不锁定格式）。

### 3.3 对比矩阵（官网自建，覆盖 10+ 产品）

官网准备了一份横跨"云编辑器 / 本地 IDE / Typst 生态 / Word-Google Docs / AI 写作工具"的长对比表，维度包括：

协作与版本 / 引擎与 TeX 安装 / 代码与可视化编辑 / 源码- PDF 双向同步 / 模板 / 导入导出 / AI 模型选择与 CLI agent / 本地 AI / AI 改动可审阅 / 文献检索 / 研究任务 / 引用库导入 / MCP / 拼写语法 / 图表 / 投稿校验 / 无障碍 / 隐私。

这张表本身就是产品资产：它把"**该拿什么尺子量科研写作工具**"定义了一遍，而这个尺子恰好是 Oleafly 自己优势最大的维度。

---

## 4. 功能架构拆解

### 4.1 信息架构

```
Library（书架首页）
├─ New project ─ 研究项目 / 导入项目 / 模板（含 AI 生成模板）
├─ Home dock ─ Diagram Composer / Oleafly Tools(37) / 全局搜索 / 主题 / 设置
└─ 项目卡片 ─ 封面色、hover 首页预览、收藏、fork（带 Git 历史）、回收站

Project（工作台）
├─ 左侧 Rail（按 contribution registry 静态注册）
│  ├─ explore：文件树+Outline / 引用与符号面板 / 研究空间
│  ├─ review：Git Source Control / Preflight / Versioning(checkpoint)
│  └─ assist：AI Chat / Research Tasks
├─ 中央：Code / Visual 编辑器 + PDF 预览（Split / Editor only / PDF only）
└─ 底部：Terminal（多会话）/ Logs / 汇总设置
```

两个设计选择值得注意：

1. **Library 是首页，项目是"书"**：封面色存在项目元数据里、hover 显示上次编译 PDF 的第一页、右键可 fork 整个项目连 Git 历史。用"书架"隐喻替代文件列表，降低"论文很多"的认知负担。
2. **Rail 分区（explore / review / assist）**：把"材料阅读""质量把关""让 AI 干活"在导航层就分开，暗示了产品的价值分层。

### 4.2 模块逐一拆解

#### ① 项目与模板系统

- **23 个内置模板**（Blank/IEEE/ACM/Elsevier/Thesis/Book/Beamer/Poster/Resume×4/Newsletter/Letter…）+ **11 个可下载包共 99 个**。
- 模板卡片直接渲染"编译后的第一页预览"，并带 **engine 标签、Offline 标签、ATS-friendly / Design-forward 徽章、许可证与作者**。
- 支持"**用 AI 生成模板**"：描述版式 → 生成源码 + 预览 → 保存进画廊复用。
- **研究项目 starter**：Article / Literature review / Thesis / Reproducible analysis —— 创建时就生成 `manuscript + analysis + figures + research notes + sources + review notes` 目录结构，并附带第一条 Research Task 建议。

> 设计意图：把"空目录焦虑"和"我该从哪开始"这两个科研写作最强阻力前置解决。

#### ② 编辑器

- **CodeMirror 6** 内核，支持 LaTeX / Typst / Markdown / BibTeX 语法高亮、折叠、多光标、列选择、Find&Replace（含 Preserve case / Select all matches）、Vim 模式、word count。
- **Visual（可视化）编辑**：LaTeX/Markdown 可切 Code/Visual，TipTap 驱动，公式、脚注、定理、图表、表格渲染为可编辑节点，**不支持的 LaTeX 构造保留为可编辑源码块而不是丢弃**（这是很多可视化编辑器翻车的地方）。
- **内置 LaTeX linter**：环境配对、未闭合环境、重复 `\label`、行内 `$` 数量为奇数——**编译前就给反馈**。
- **项目级索引 / code intelligence**：F12 跳定义、Shift+F12 找引用、F2 全项目重命名（label、citation key、macro、环境）、hover 显示编译后的编号与页码、KaTeX 公式悬浮预览、跨文件 Outline。
- **自动补全**：命令、环境、label、citation key、项目路径，且**包感知**（package-aware）。
- **236 个 LaTeX 符号面板**（分类 + 搜索 + 插入）。

#### ③ 编译与引擎（护城河之一）

| 引擎 | 说明 |
|---|---|
| Tectonic（内置） | XeTeX 系、首次按需下载宏包并缓存、离线模式用 `--only-cached` 保证不偷偷联网 |
| latexmk（系统 TeX） | 支持 pdfLaTeX / XeLaTeX / LuaLaTeX；优先识别已有 MacTeX / TeX Live / MiKTeX；否则可下载**托管 TinyTeX（约 250 MB，免管理员权限）** |
| Typst（内置） | 直接调用固定的 Typst CLI，输出 PDF，能力声明为不支持 SyncTeX / 离线 / 独立编译 |
| Markdown | Pandoc → 内置 Tectonic 出 PDF |

**可靠性细节**（这是"工程诚意"最能体现的地方）：

- 编译前先保存当前文件，保证 PDF 与所见一致。
- auto-compile 为 2.5s 防抖，且"最新优先 + 只排一个后续任务"，编译风暴不会形成。
- 被取代/超时的编译会**杀掉整棵进程树**，并有 300 秒硬超时。
- 编译结果带请求身份，乱序返回的旧 PDF 会被拒绝显示而不是画错。
- 日志解析成结构化诊断（类型 + `l.42` 行号），错误直接映射为编辑器 squiggle。
- 缺宏包时报出**拥有该文件的 TeX Live 包名**并提供"Find and install"。

#### ④ PDF 预览与 SyncTeX

单页/双页/连续滚动、缩放 40%–400%、Fit to width/height、反色、旋转、Reader view、PDF 内搜索、大纲跳转、多窗口分离预览、把 PDF 存回项目、加密 PDF 密码提示。

**"保留最后一次可用 PDF"** 的机制很关键：编译失败或正在编译时不会清空阅读区，而是显示 stale 提示。SyncTeX 双向跳转（源码 ⇄ PDF）在支持引擎上默认开启。

#### ⑤ 文献与引用

- **Citation Search**：聚合 arXiv、Semantic Scholar、Crossref、PubMed、OpenAlex（Google Scholar 需自带 Serper key），跨源去重，结果带题名/作者/年份/venue/标识符。
- **From document（段落级找引）**：把稿件或选区拆成段落，逐段检索、过滤已在参考文献库中的条目、按 0–100 分排序；接 AI 时可给出"支持/不支持该引用"的理由。
- **标识符直取**：DOI / arXiv ID / ISBN / PMID / URL / 题名 → BibTeX，**DOI 已存在时复用条目、新 key 自动避让冲突、插入光标处并立刻刷新面板**。
- **参考文献库导入**：BibTeX / RIS / EndNote XML / Zotero RDF，按 DOI 去重后一次性追加。
- **Clean library（清理库）**：预览 key 重命名、DOI 去重、疑似重复；**只有"保留条目包含被删条目全部字段"时才自动去重**，冲突只标记不合并，且改动前备份。
- **Zotero / alphaXiv 集成**（API key，本地保存）。
- 引用链可追溯：claim → key → bib entry → 真实来源，未解析/歧义 key 在编译前就标记。

#### ⑥ AI 层（详见第 5 章）

内置 Chat（带工具）+ Inline edit（⌘L 选中改写，流式 diff，Enter 接受 / Esc 拒绝）+ AI Figure + Skills + Research Tasks + Usage/Budget，四种运行通道（云 API / 本地 Ollama / 自定义 OpenAI 兼容端点 / 已装 CLI agent）。

#### ⑦ Research Tasks（隔离式委派）

给 agent 一个"有边界的活"：**在隔离副本上工作**（macOS/Linux 用系统隔离工具；Windows 上 CLI 隔离任务不可用），产出走"任务队列：等待 / 运行 / 待审 / 完成 / 失败 / 取消"，支持编辑排队任务、取消、重试、任务间依赖。

**审阅与应用**：进入 review 后逐个文件看 diff，选择性 apply；**应用时校验目标文件是否仍与任务起点一致，冲突则拒绝写入并保留结果供复核**。这一条（并发写保护）是很多"AI 帮你改论文"产品缺失的。

#### ⑧ 图表

- **Diagram Composer**：左侧画布（矩形/圆/椭圆/菱形/文本块 + 连箭头，吸附网格），右侧实时编译预览，Draw/Code 双标签；输出 **TikZ 源码**。
- **可回环**：图形模型内嵌进 `.tikz`，下次可重新打开编辑；也支持把受支持的外部 TikZ 反向载入画布。
- 插入方式二选一：**可编辑矢量源码** 或 `\includegraphics` PNG（1x/2x/3x、透明底）。
- 独立编译沙箱，半成品图不会污染主文档编译；可另存为 image 项目（导出矢量 PDF / PNG）。
- **AI 画图**：描述 → 生成 TikZ/PGFPlots → 独立预览 → 读日志修复 → 插入带 caption/label；视觉模型可看渲染图。

#### ⑨ Preflight（投稿前校验，护城河之二）

六项独立检查：

1. **Compile & layout**：失败构建、未解析引用、rerun 警告、缺字形、overfull box、文字裁切、重复 PDF 目标、混用页面尺寸。
2. **Submission readiness**：按 profile（通用/arXiv/IEEE/ACM/journal/thesis）检查文档类、摘要关键词、图格式、字体嵌入、caption、可移植文件名、源码包整洁度。
3. **ATS readiness**：模拟 ATS 抽取简历字段与栏目，报告会打乱阅读顺序的版式。
4. **Accessibility**：tagging、alt text、语言与标题元数据、标题层级、表格表头、链接描述、阅读顺序、可选中文本、字号；对照 PDF/UA-1 的 **106 条机器可检查规则**并报告 verified/advisory/manual 三档确定性。
5. **References & assets**：缺文件、未解析引用与交叉引用、重复 label/DOI、bib 字段不全、未被引用的参考文献。
6. **Privacy & blind review**：凭据、私钥、敏感文件、草稿笔记、致谢、作者字段、身份元数据。

并且它会"**诚实地承认边界**"：明确写着这不是 PDF/UA 认证，alt text 是否达意、阅读顺序是否合理、对比度是否足够仍需人工与第三方工具（veraPDF / PAC 2024）验证。

#### ⑩ 版本、协作与备份

- **Saved Checkpoints**：**每次成功编译且项目有变更**时后台快照（不产生 Git 提交、跨引擎生效），可加标签（"投稿稿""方法章改写前"）、可恢复、可导出**密码加密的历史归档**。
- **Git**：真实仓库，diff（split/unified）、暂存、提交、恢复提交；GitHub sync 支持 device code OAuth（scope: `repo` + `read:user`）或 PAT，publish/push/pull、ahead/behind 指示。
- **安全实现**：token 存 AES-256-GCM 加密、仅属主可读的本地文件，**永不进入 webview**，通过内存 credential helper 注入 Git，不出现在命令行、`.git/config` 或 shell history；老版本写在 remote URL 里的 token 会在启动时清理。
- **明确不做的**：不做应用内冲突解决、不做分支 UI、不做托管云同步。

#### ⑪ Oleafly Tools（37 个工具）

分四组：

- **转换与生成**：Image→LaTeX/Typst、PDF→LaTeX/Markdown/Typst、Word→LaTeX、LaTeX→Word/HTML/Markdown/Typst/Image、Markdown/Typst→LaTeX、Excel→LaTeX、Mermaid→LaTeX、Equation→LaTeX、arXiv→LaTeX、Table→LaTeX、Typst 编辑器（含可视化）。
- **文献构建**：DOI/ISBN/PMID/arXiv/URL→BibTeX、Citation Generator、Bibliography Generator、8 种引用风格对照、BibTeX 校验器。
- **研究与检查**：Find Citations、Lab Search（OpenAlex 机构库）、Conference Deadlines（含时区与"估计日期"标记）、统计计算器（p 值/样本量/置信区间，本地算）、Symbol Reference。
- **写作辅助**：Writing Generators（把选区变成有依据的 prompt）。

**隐私分级做得非常清楚**：文档转换本地跑（Pandoc 不上传）、图像/扫描件用本地 Ollama 视觉模型、标识符检索才联网、统计与引用格式化完全离线。且每个工具明示限额（通用文件 128 MB、图像 20 MB、扫描 PDF 50 页、表格首表 10k 行 × 100 列 × 2 MB 文本）。

#### ⑫ 本地化与设置

- 应用界面：English + 简体中文（可随系统），**与稿件语言、校对语言、AI 输出语言完全解耦**。
- 校对：Hunspell（拼写）+ Harper 2.10（英文语法风格）全本地；**LaTeX-aware 的 prose mask** 会跳过命令、注释、公式、引用语法、URL、代码区；提供"学术 profile"关掉与学术写作冲突的规则（长句、hedging、`kB`/`min` 等缩写、牛津逗号之争），每条被关掉的规则都给出原因与示例。
- Appearance：主题、强调色、背景、字体、打开布局（split/editor/pdf）、编辑器行为、终端外观、PDF 默认行为。
- 设置里还带 **Experimentation 开关**（Visual editor / LaTeX tools / Web browser 默认关闭）——用实验开关控制风险功能的曝光。

### 4.3 核心用户旅程：Oleafly 定义的"研究闭环"

```
新建研究项目（starter 决定目录结构 + 首条任务）
   ↓
找文献：Citation Search / From document 扫引 / DOI 直取  → 入 .bib
   ↓
写：Code 或 Visual 编辑，@文件 给 AI 上下文，cite 自动补全
   ↓
画图：Diagram Composer 或 AI 生成 TikZ，独立编译预览后插入
   ↓
编译：Ctrl+Enter，PDF 并在旁，日志结构化，失败自动给建议
   ↓
核验：SyncTeX 双向跳转 + 校对 + Preflight 六项
   ↓
留痕：成功编译自动 checkpoint + 命名 Git 提交（可 push GitHub）
   ↓
交付：导出 PDF / 源码 ZIP / DOCX / HTML(MathML) / MD / PPTX / EPUB
```

这套流程的巧妙之处：**每一步都留下可复用的中间产物**（bib、TikZ、日志、截图、checkpoint），使"下一次修改"不必重建上下文。

---

## 5. AI 能力拆解（差异化核心）

### 5.1 四种接入路径

| 路径 | 说明 | 谁付费 |
|---|---|---|
| 云 Provider | OpenAI、Anthropic、Google Gemini、Perplexity、Z.AI、Groq、OpenRouter、DeepSeek、Mistral、xAI | 用户 |
| 本地模型 | Ollama（自动检测/启动/列模型/自定义 host） | 免费 |
| 自定义端点 | OpenAI 兼容的网关/自建服务 | 用户 |
| CLI Agent | Claude Code、Codex CLI、Gemini CLI、Pi、OpenCode、OpenClaw、Cline、Hermes、CodeBuddy、Kimi Code、Grok Build、Cursor、DeepSeek Harness、Qoder（14 个） | 用户订阅 |

**"BYO 一切"的商业含义**：Oleafly 不碰推理成本，也不绑定任何模型厂商；模型能力矩阵（context/vision/tools/reasoning）与"Verified/Untested/Blocked"工具调用能力徽章帮助用户选模型，并明确声明这**不评价写作与研究质量**。

### 5.2 上下文与工具

- **上下文来源**：`@` 文件（带内容）/ `@` 文件夹（带清单）/ 附件（图片、PDF、文本、LaTeX、Typst、BibTeX、Markdown）/ 当前选区 / 项目索引（`project_map`：大纲、label、引用、宏、文件依赖、未解析引用）/ **Linked folders**（只读挂载外部数据与 PDF 目录）/ PDF 渲染页截图（可开关，供视觉检查布局）。
- **工具面**：读写文件、编译、读日志、检索文献、元数据查找、画图并独立编译、PDF 文本与页面检查、Shell 命令等；工具按引擎与运行时动态可用（能力不足就隐藏而不是报错）。

### 5.3 审批与安全模型

四档模式（按项目保存）：

| 模式 | 读类工具 | 写文件/执行命令 |
|---|---|---|
| Ask for approval | 可运行 | 需批准 |
| Approve for me（默认） | 可运行 | 需批准 |
| Full access | 可运行 | 直接执行 |
| Custom | 按规则 | 按 `~/.oleafly/approvals.toml` 的 allow/deny 规则 |

外加：

- **Plan 模式**：先读、先搜、先给 checklist，等用户 Approve plan / Revise 后才动手。
- **内联编辑**：⌘L → 流式 diff → Enter 接受 / Esc 拒绝 / 一键重试。
- **中途转向**：运行中排队消息，选 "Steer now" 在下一个安全点注入。
- **多 agent 可配置**：`agent.toml` 控制 `maxAgentDepth=2`、`maxConcurrentSubagents=8`、等待超时、委托提示词与子 agent 指令。
- **用量与预算**：按项目/模型/运行时/日期统计 input/output/cache，区分 measured/estimated/unknown；项目预算达 80% 预警、达上限阻止新运行（明确说明这是"启动前检查"而非运行中熔断，且不覆盖所有外部 agent）。

### 5.4 Skills 体系

- 12 个内置科研技能：`research-loop`、`literature-sweep`、`manuscript-scaffold`、`related-work`、`data-analysis`、`figure-prep`、`verify-claims`、`review-manuscript`、`pre-submission`、`response-letter`、`slides-and-posters`、`latex-build`。
- **兼容 Agent Skills 标准**（`SKILL.md` + 可选 scripts/references/assets），可导入文件夹、可在 Domain shelf 安装领域技能包。
- **Record a skill**：把一次成功的对话反向蒸馏成可复用流程——这是"用户教产品"的机制，能持续沉淀组织知识。

### 5.5 这套 AI 设计在解决什么

| 常见痛点 | Oleafly 的机制 |
|---|---|
| AI 改稿后我不知道它改了什么 | 流式内联 diff + 审批模式 + 工具活动卡 |
| AI 编造引用/结论 | 指令模板显式要求"不发明引用与结果、需要证据就标记"；引用走真实检索；claims 校验用 skill |
| AI 动了我正在改的文件 | 隔离副本 + 冲突拒绝 + 选择性 apply |
| 我不知道花了多少钱 | 用量报表 + 项目预算 |
| 我不想把稿子发到云 | 本地 Ollama + 自定义端点 + PDF 截图开关 + 无遥测 |
| 我已有团队/个人的 agent 习惯 | 接 CLI agent 或双向 MCP（既能用外部工具，也能让外部客户端操作 Oleafly 项目） |

---

## 6. 技术架构（可验证部分）

### 6.1 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | **Tauri 2**（Rust 后端 + 系统 WebView），启用 `macos-private-api` 与 multi-webview（内嵌浏览器面板） |
| 前端 | React 19、TypeScript、Vite 6、Tailwind v4、Zustand、TanStack Query、Radix/shadcn、cmdk、i18next |
| 编辑器 | CodeMirror 6 全家桶（含 vim/emacs/merge/search/lint）、TipTap 3（可视化编辑）、KaTeX + MathJax、Mermaid |
| PDF | pdf.js 6.2（自建虚拟化 viewer、worker、SyncTeX 控制器） |
| 图形 | React Flow（`@xyflow/react`）做 Diagram Composer |
| 终端 | xterm.js + portable-pty |
| 引用 | citation-js、unified-latex、biblatex crate |
| 校对 | hunspell-asm + harper.js |
| Rust crates | 自研 `oleafly-agent`（provider/streaming/agent 编排）、`oleafly-core`、`oleafly-history`；axum、rusqlite、reqwest(rustls)、ring、argon2、AES-CBC、zip/flate2/tar |
| 质量 | Biome lint、Vitest（含 coverage）、Playwright E2E（真实启动应用 + 真实编译器）、SonarCloud quality gate + coverage、`cargo deny`/`pnpm audit` |
| 分发 | GitHub Releases + Tauri updater（minisign 签名校验）、macOS Apple 签名公证、Windows Azure 签名 |

### 6.2 架构原则（比技术选型更值得学）

1. **依赖反转的包化**：12 个 `@oleafly/*` 前端包以**源码形式**被消费（`main` 指向 `src/index.ts`，无构建步骤、无版本漂移）。包只能依赖注入的 "ports"（Host 端口 / UI Kit / hook 形端口 / 模块单例），**禁止反向 import app、Zustand、Tauri、UI 组件**，并用一条 grep 做纯度检查。
2. **Contribution Registry**：rail 标签、命令面板/omnibar 命令、AI toolset 都通过 `registerRailTab / registerCommand / registerAiToolset` 静态注册，shell 不认识任何具体功能。"没有 shell 改动就能加功能"。
3. **失败关闭（fail-closed）的引擎能力描述**：前端不靠扩展名猜行为，而读后端 `project_engine` 描述符（`supports_synctex`、`supports_offline`、`supports_isolated_compile`…）。典型例子：Typst 明确声明不支持 SyncTeX/离线/独立编译，于是相关 UI 被隐藏或归零，且文档写明"**先让后端能力真实，再加 UI**，不要加基于扩展名的特例"。
4. **秘密不出 WebView**：provider 请求、GitHub OAuth device flow、MCP 路由都在 Rust 完成，CSP 不需要放行 GitHub API origin，前端只知道"已连接为 @you"。
5. **供应链可复现**：Tectonic / Biber / Typst / language server 的下载脚本**版本固定 + 校验和校验 + 只解压白名单路径**，CI 与发布用同一脚本。

### 6.3 数据与文件布局

```
~/.oleafly/
├─ config.json            非敏感偏好（0600）
├─ ai-secrets.json        AI provider 密钥（AES 加密）
├─ app-secrets.json       GitHub / MCP 凭据（AES 加密）
├─ ai-secrets.key         仅属主可读的密钥文件
├─ approvals.toml         项目审批模式与逐工具 allow/deny 规则
├─ agent.toml             多 agent 深度/并发/超时/提示词
├─ tinytex/               托管 TinyTeX（约 250 MB）
├─ app.log
└─ projects/<id>/         普通项目文件夹
   ├─ project.json        主文档、引擎、项目身份
   ├─ .git/               真实 Git 仓库
   └─ .oleafly/build/     可重建的编译产物
```

**关键取舍**：checkpoint 历史**存在项目文件夹之外**，所以源码 ZIP 和 Git push 都不会带走它——文档明确告知用户"要单独导出加密归档"。这种"诚实地暴露边界"的做法，减少了后续支持成本。

---

## 7. 商业模式与成本结构

### 7.1 现状：没有商业模式

- **定价**：完全免费（"Free forever"），无 Pro、无 Team、无企业版，`/pricing` 返回 404。
- **无账号、无订阅、无遥测**；唯一的"付费"发生在用户自己的模型厂商账单上（或本地模型，零成本）。
- **许可**：AGPL-3.0-or-later。对桌面应用来说这是一个**选择性的强 copyleft**：第三方若把它做成网络服务必须开源，但普通用户/研究者使用不受影响。

### 7.2 成本结构（推断）

| 成本项 | 说明 | 量级 |
|---|---|---|
| 推理成本 | **为零**（BYO key / 本地模型） | — |
| 服务器 | 无托管业务后端；仅静态站 + CDN（截图、字体包、模板包、技能包） | 低 |
| 发布与更新 | GitHub Releases + 更新源带宽；签名与公证 | 低-中 |
| 开发 | 单人主导 + 社区 PR，跨三平台发布工程量大 | **主要成本** |
| 支持 | Discord + GitHub Issues | 人力 |

### 7.3 可能的变现路径（我的判断，非官方信息）

1. **托管协作/同步**：官方已把 "real-time co-editing、comments、managed sync、team spaces" 列为 planned。托管版是唯一自然且不违背 local-first 的收费点（本地仍免费，协作收费）。
2. **团队/机构合规**：SSO、审计日志、私有更新源、模板与技能库治理、机构级部署（对标高校 IT 采购）。
3. **支持与赞助**：GitHub Sponsors / 机构赞助 / 优先支持 SLA。
4. **模板与技能市场**：目前模板包与领域技能都免费；出版社/期刊定制模板包存在 B 端付费空间。
5. **企业版桌面许可**：保留 AGPL 社区版，商业许可豁免给不愿受 AGPL 约束的公司（双许可）。

> 风险提示：AGPL + 无账号意味着**无法从现有用户身上直接收费**，任何变现都要新增一条产品线，而不是把现有功能加锁。

---

## 8. 增长与渠道拆解

### 8.1 十三个增长杠杆

| 杠杆 | 具体做法 | 目的 |
|---|---|---|
| SEO 工具页 | 37 个工具各有一页文档，且每个工具都是独立搜索意图（"PDF to LaTeX"、"DOI to BibTeX"、"Excel to LaTeX"） | 长尾自然流量 |
| 博客集群 | 19 篇，分三类：**迁移叙事**（Overleaf / TeXstudio / LaTeX Workshop）、**学科攻略**（物理/化学/生物/经济/人文/Math/工程/Machine Learning）、**工作流/痛点**（Git 协作、TikZ 图、会议 deadline、隐私与基金写作） | 决策期搜索 + 长尾 |
| 落地页多语言 | 官网提供 12+ 语言版本（/zh-cn、/ja、/ko、/de、/fr、/es、/ru、/ar、/hi、/tr、/vi、/uk…） | 非英语市场（也是目标用户主力） |
| 对比表 | 一张覆盖 10+ 产品的长对比表，定义评价维度 | 抢"哪个好用/替代品"类搜索 |
| 模板生态 | 122 个模板 + 独立 GitHub 仓库（template-packs，开放许可） | 高频具体需求入口（简历/学位论文/海报） |
| 迁移叙事 | 专门写"从 Overleaf / TeXstudio / VS Code 迁过来" | 精准抢夺已付费/已重度用户 |
| GitHub 作为门面 | AGPL、issue/PR 模板、Discussions、SonarCloud/Coverage/CI/Downloads 徽章 | 极客信任 |
| 社区 | Discord（应用内 Help 会显示在线人数）+ 用 Discord 替代论坛 | 留存与支持 |
| 产品内虚荣指标 | Help & About 拉取 GitHub star 数与 Discord 在线数 | 社会证据 |
| **学术引用闭环** | 内置 Oleafly 的 BibTeX，可一键写入当前论文参考文献 | 被引即长期曝光（学术产品独有） |
| 演示即产品 | 首页用**自己写的真实论文**（TeXFix-Bench，LaTeX 修复基准）作为演示项目，含真实日志、真实编译耗时、真实模型成本 | 可信度 + dogfooding |
| 免费开源 | 无账号、无试用、无功能锁 | 消除试用摩擦 |
| 文档为 AI 优化 | `llms.txt` 全量索引 + 每页 "Copy page as Markdown / View as Markdown / Open in ChatGPT / Open in Claude" | 让 AI 助手直接成为分发渠道 |

### 8.2 漏斗观察

```
搜索（工具/迁移/学科/对比）→ 官网（本地化落地页 + 演示）→ GitHub Releases 下载
   → 首次编译成功（内置引擎，无配置摩擦）→ 模板/文献/AI 上手 → Discord / Star / 引用
```

公开数据的一个有趣信号：**安装包下载 2290 次 vs GitHub star 171**（约 13:1）。说明"下载即用"的转化做得不错，但"开发者社区认同"的转化还早期。这可能意味着真实用户更偏向"普通科研用户"而非开发者——这也解释了为什么产品要把简历、ATS、Word 导入导出做得这么认真。

### 8.3 内容策略的取舍

值得学习的是它**刻意写"边界"**：博客坦承哪些还属于云端更合适、文档坦承 Preflight 不等于 PDF/UA 认证、GitHub sync 坦承不能解冲突。对科研用户而言，"知道工具什么时候会失败"比"功能列表长"更重要。

---

## 9. 可观测指标汇总

| 指标 | 数值 | 来源与解读 |
|---|---|---|
| 首次提交 / 仓库创建 | 2026-07-05 | 产品从 0 到当前形态约 11 周 |
| 最近推送 | 2026-09-21（调研当天） | 高频迭代，"ultra active" |
| Star / Fork | 171 / 20 | 极早期项目 |
| 开放 issue / PR | 11 / 18 | PR 数超过 issue 数，社区贡献活跃或维护者自驱 |
| 安装包下载 | 2290 | README 徽章（badges 分支自动统计） |
| 发布版本 | 页面可见 v0.3.6→v0.4.1（至少 9 个），另有 v0.4.0、v0.3.7–13 | 发版节奏约每周多次小版本 |
| 仓库体积 | ~149 MB | 含资源与文档 |
| 文档页数 | 112 | 文档密度远超同阶段产品 |
| 模板数 | 23 内置 + 99 可下载（11 包） | 生态型资产 |
| 工具数 | 37 | SEO + 实用双用途 |
| 支持的模型通道 | 11 家 provider + 自定义端点 + Ollama + 14 个 CLI agent | 生态整合能力 |
| 应用界面语言 | 2（EN / zh-CN） | 与官网 12+ 语言形成反差，说明界面本地化滞后于营销本地化 |
| 不可见指标 | DAU/WAU、留存、编译失败率、AI 采用率、checkpoint 使用率 | 无遥测，产品方也不掌握——这是 local-first 的代价 |

---

## 10. 竞争格局与定位地图

### 10.1 两个轴向

```
                    本地 / 文件自持
                          ▲
        VS Code + LaTeX   │   TeXstudio
        Workshop          │
                          │        ★ Oleafly
        ──────────────────┼──────────────────►
        单一功能           │            一体化工作台
                          │
        Typst App         │   Overleaf
                          │   (云 + 协作)
                          ▼
                       云托管
```

Oleafly 占据的是右上角空位：**一体化 + 本地**。这个位置此前几乎没有成熟产品，这正是它的机会，也是它的教育成本。

### 10.2 护城河评估

| 能力 | 强度 | 说明 |
|---|---|---|
| 内置跨平台 TeX 工具链 | ★★★★ | 工程量大、易被低估；云端产品不会做，DIY 栈要用户自己做 |
| Preflight / ATS / 无障碍校验 | ★★★★ | 需要领域知识 + PDF 底层解析，难被快速复制 |
| AI 审批/隔离/审计模型 | ★★★ | 机制设计优秀，但竞品短期可跟进 |
| 模板 + 技能 + 工具生态 | ★★★ | 数量优势，可被追赶 |
| 文档密度与诚实度 | ★★★ | 是信任资产，也是支持成本 |
| 品牌与社区 | ★★ | 仍早期，171 star |
| 数据/协作网络效应 | ★ | 无云、无协作，几乎为零 |

### 10.3 结构性弱点

1. **无网络效应**：本地优先 + Git 协作意味着用户之间不产生产品内连接。
2. **协作是短板**：实时协同、评论、团队空间全部 planned；而 Overleaf 的护城河恰在此。
3. **不可观测**：没有遥测 → 无法知道用户在哪儿卡住，产品决策依赖 issue 与 Discord。
4. **单点人力风险**：跨三平台 + 签名 + 自动更新 + 双引擎编译链，维护负担重。
5. **AI 质量不可控**：模型由用户选，体验方差大；写坏的稿子依旧是用户的问题。
6. **本地化滞后**：官网 12+ 语言，应用仅 2 语言，非英语用户体验断层。
7. **AGPL 的 B 端摩擦**：企业/机构法务可能拒绝 AGPL 组件，限制机构化推广。

---

## 11. 优势 / 劣势 / 机会 / 威胁

**优势（Strengths）**

- 定位清晰且真实："local-first + 一站式 + 可选 AI"。
- 工程可靠性远超同类早期产品（进程树取消、超时、乱序结果拒绝、校验和 sidecar、密文凭据）。
- 无账号/无遥测/无订阅 → 采纳摩擦极低，科研隐私叙事强。
- 文档质量极高：112 页，含边界声明、限额、失败排查。
- AI 治理模型成熟：四档审批、Plan、内联 diff、隔离任务、预算。
- 增长资产成型：37 工具页 + 19 博客 + 122 模板 + 12 语言落地页 + 对比表。

**劣势（Weaknesses）**

- 无协作、无云同步、无团队空间（用户明确的未满足需求）。
- 无商业模式，长期可持续性未验证。
- 无遥测 → 产品决策缺乏数据。
- Windows 上 CLI 隔离任务不可用，功能矩阵在三平台不一致。
- Intel Mac / Windows ARM 无原生包。
- 应用本地化仅 2 种语言。
- 学习曲线仍在（LaTeX 本身 + 大量功能 + 37 工具）。

**机会（Opportunities）**

- Overleaf 免费额度收紧 / 用户疲劳 → 迁移叙事有效。
- 高校数据合规要求上升 → 本地优先的机构采购机会。
- Typst 生态正在爆发 → 已经提前布局。
- AI 编码 agent 走入主流 → CLI agent 接入把"别人的 AI 订阅"变成自己的功能。
- 出版社/期刊模板与投稿校验可 B 端化。
- 被引用（Cite Oleafly）可带来学术传播复利。

**威胁（Threats）**

- Overleaf / Typst App 增加本地或离线能力。
- VS Code + Copilot 通过扩展组合出"够用"的替代方案。
- AI 写作工具（Paperpal、Writefull 等）向编辑器一体化演进。
- 单人维护的项目一旦停更，用户迁移成本高（本地文件降低了这一风险）。
- AGPL 与商标/品牌被第三方利用的风险（无实体公司）。

---

## 12. 对 Scientify 的启示

### 12.1 先明确边界：你们不在同一个战场

| | Oleafly | Scientify（现状） |
|---|---|---|
| 核心对象 | **文档**（稿件） | **研究过程**（问题/假设/设计/实验/决策/文献） |
| 主战场 | 写作、排版、引用、校验、投稿 | 实验记录、指标比较、代码版本、证据链、团队空间 |
| 技术栈 | Tauri 2（Rust + React） | Electron（Node + 渲染层） |
| 本地 AI | Ollama + 云 + CLI agent | 仅 Ollama |
| 编译链 | Tectonic/Typst/Pandoc 内置 | 依赖本机 XeLaTeX |
| 增长 | SEO 内容 + 开源 + 模板生态 | 尚未建立 |

结论：**不要在 LaTeX 编译链和排版校验上与 Oleafly 正面竞争**，那是它 11 周高强度投入 + 差异化叙事的核心资产。Scientify 的差异化在"**实验与证据的可追溯性**"，这是 Oleafly 明确不做的部分（它连实验管理都没有）。

### 12.2 建议直接借鉴的 10 条

1. **预置工具链，别让用户装环境**：Oleafly 内置 Tectonic/Typst/Pandoc，把"配置税"降到零。Scientify 目前要求本机 XeLaTeX + ctex，这是首日流失点。至少提供"一键检测 + 引导安装"，中长期考虑打包轻量引擎或提供云端编译选项。
2. **失败关闭的能力描述（fail-closed capability descriptor）**：让后端返回能力标志（有无 Git、有无 XeLaTeX、有无模型、有无 OCR），UI 据此显示/隐藏，**不要靠文件扩展名或 try-catch 猜**。这能消灭一大类"看起来能用其实报错"的体验。
3. **四档 AI 审批模式 + 项目级规则文件**：Ask / Approve for me / Full access / Custom + `approvals.toml` 式逐工具 allow/deny。你们的助手目前是"选了材料就能问"，加入"写操作审批"会立刻把可信度提升一个档。
4. **隔离任务 + 选择性应用 + 写冲突拒绝**：Research Tasks 的"副本上跑 → diff 审阅 → 逐文件 apply → 目标已变更则拒绝"是目前最完整的科研 AI 委派范式。对"让助手批量整理文献笔记/生成实验摘要"这类场景非常适合。
5. **成功即快照（checkpoint）**：Oleafly 在**每次成功编译后**自动存快照，与 Git 解耦。Scientify 可以把触发点换成"每次保存实验记录/提交 Git 后"，给"研究过程"一条低摩擦的时光机。
6. **用量与预算可见**：即使只有本地模型，也应展示 token/耗时/运行次数，并支持项目预算。科研用户对"我在哪儿花了多少"有天然需求。
7. **诚实声明边界**：Oleafly 明确写"这不是 PDF/UA 认证""unknown 不代表 0""预算检查不是熔断"。这降低了误用与支持成本，也是科研用户的信任来源。Scientify 应对"AI 摘要可能出错""PDF 取文不含 OCR""Git 不自动 push"这类边界做同样的显式声明（现在 README 里有，但应进入产品内）。
8. **文档即增长资产，并为 AI 优化**：112 页文档 + `llms.txt` + "Open in ChatGPT/Claude"。建议 Scientify 建一份 `llms.txt` 与结构化文档（模块说明、限额、失败排查），既服务用户，也让自己出现在 AI 回答里。
9. **模板与"起点"消除空目录焦虑**：Oleafly 用 starter 决定目录结构 + 首条任务。Scientify 的"研究项目"可以给更强的 starter：例如"复现实验"模板自动生成 `data/ scripts/ results/ notes/ decisions/` 与第一条待办，并绑定一个实验记录骨架。
10. **本地优先的承诺要贯穿到实现细节**：密钥加密且不进渲染层、请求只在用户动作时发出、无遥测。这些都可以在 Scientify 里低成本实现，并直接写进产品叙事。

### 12.3 建议差异化（Scientify 独有的 8 条）

1. **证据链（Evidence graph）**：把"文献摘录 → 研究问题 → 假设 → 实验 → 指标 → 结论 → 论文段落"连成可点击的链。Oleafly 只有 claim→citation，你们可以做 claim→evidence→experiment→code commit。
2. **实验与代码版本绑定**：记录每个实验对应的 Git commit、环境、命令、参数与指标，支持"同一指标跨实验比较"（你们已有雏形）。这是 Oleafly 完全空白的领域，也是计算实验研究者的刚需。
3. **可复现性检查（Reproducibility Preflight）**：把 Oleafly 的 Preflight 思路搬到实验侧——检查"实验是否有环境记录/种子/数据版本/可重跑脚本/结论是否被记录支撑"，输出 verified/advisory/manual 三档确定性。
4. **团队空间真正落地**：Oleafly 把 team spaces 列为 planned；你们已有团队概念但无协作。哪怕先做"共享只读快照 + 评论"，也能占住这个位置。
5. **项目 = 研究工作台而非稿件**：保留 LaTeX 导出为兼容出口，但主入口应是实验与证据看板。避免 UI 被"论文写作"主导。
6. **AI 助手带"研究判断"边界**：不只做改写，而做"这个结论是否被实验支撑""这两个指标差异是否显著"的检查型任务，并强制人工复核（你们 README 已有此立场，应产品化）。
7. **数据与附件的本地治理**：数据集、附件、断点、导出包的一致性校验（类似 Oleafly 的 checkpoint 加密归档），是科研用户会付费/推荐的能力。
8. **开源策略要早决定**：Oleafly 用 AGPL 换取了信任与社区 contributor。Scientify 若走开源，建议同样用强 copyleft 保护核心，但**必须先决定**，因为它决定架构（是否把服务端当独立产品）与增长（是否能进高校采购）。

### 12.4 建议立刻做的三个验证实验

| 实验 | 假设 | 最小成本做法 |
|---|---|---|
| A. 工具链摩擦测试 | "不装 XeLaTeX 的用户会在 10 分钟内流失" | 招募 5 名目标用户，记录从启动到导出 PDF 的失败点；对照 Oleafly 的零配置体验 |
| B. 证据链价值测试 | "实验-结论-文献的可追溯链比论文排版更被需要" | 在现有项目页加一条"证据链"只读视图，观察使用率与用户口述 |
| C. AI 委派信任测试 | "用户愿意用 AI 做文献整理，但必须能逐条审阅" | 实现"草稿队列 + 逐条接受/拒绝"，测量接受率与放弃率 |

### 12.5 明确不建议照抄的三点

- **37 个工具页**：那是 SEO 规模战，需要持续内容产能；Scientify 应聚焦 3–5 个高频工具（PDF 取文、公式/表格转换、引用导入），而不是铺量。
- **跨三平台原生桌面 + 自动更新签名**：Electron 已让跨平台成本可控，但签名/公证/更新源是长期负担，建议先用"未签名 + 手动更新"换取迭代速度，并在正式发布前再补。
- **对比大表**：早期阶段做"10 产品 × 25 维度"的对比表会稀释定位；建议先做"3 个直接替代方案"的精准对比。

---

## 13. 值得继续追踪的问题

1. 变现何时开始？托管协作版是否会出现（定价与形态）？
2. 应用界面语言会否扩张到与官网同量级？
3. Research Tasks 的隔离能力能否补齐 Windows？
4. Preflight 是否会扩展到数据/实验侧的检查（若会，与 Scientify 重叠上升）？
5. 是否有机构（高校/实验室）在采购或自托管其更新源与模板库？
6. Skills 生态是否会出现第三方市场？Domain shelf 是自营还是社区供稿？
7. 2290 次下载到实际活跃用户的转化率（需第三方近似：Discord 在线人数、issue 来源分布、更新 feed 请求量）。
8. AGPL 是否已劝退企业用户（可从 issue 中"license"关键词追踪）。

---

## 附录 A：证据来源

- 官网首页（含演示项目、对比表、理念、FAQ）：https://oleafly.com
- 产品文档总览与 LLM 索引：https://oleafly.com/docs 、https://oleafly.com/llms.txt
- 理念与定位：`/docs/philosophy`、`/docs/why-oleafly`、`/docs/workflows/research-loop`
- AI 与审批：`/docs/ai-setup`、`/docs/ai-chat`、`/docs/ai-instructions`、`/docs/ai-usage`、`/docs/ai-figures`、`/docs/ai-inline-edit`、`/docs/cli-agents`、`/docs/ollama`、`/docs/skills`、`/docs/research-tasks`、`/docs/mcp`
- 写作与编译：`/docs/editor`、`/docs/compiling`、`/docs/engines`、`/docs/latex-engines`、`/docs/export`、`/docs/synctex`、`/docs/pdf-preview`、`/docs/code-intelligence`、`/docs/autocomplete`、`/docs/spellcheck-grammar`
- 文献：`/docs/citations`、`/docs/literature-search`、`/docs/library`、`/docs/linked-folders`、`/docs/integrations/research-sources`
- 质量与版本：`/docs/preflight`、`/docs/checkpoints`、`/docs/git-history`、`/docs/github-sync`
- 工程：`/docs/engineering/architecture`、`/docs/engineering/development`、`/docs/engineering/releasing`、`/docs/engineering/updates`
- 数据与隐私：`/docs/where-your-data-lives`、`/docs/settings/*`
- 仓库与发布：https://github.com/Oleafly/Oleafly 、`/releases`、`README.md`、`package.json`、`src-tauri/Cargo.toml`
- 模板生态：https://github.com/Oleafly/template-packs
- 博客与 RSS：https://oleafly.com/blog 、https://oleafly.com/rss.xml（19 篇）
- 安装下载徽章数据：`raw.githubusercontent.com/Oleafly/Oleafly/badges/.github/badges/downloads.json`（2290）

## 附录 B：关键数字速查

| 项目 | 数字 |
|---|---|
| 首发至调研 | 约 11 周 |
| Star / Fork / 下载 | 171 / 20 / 2290 |
| 版本 | v0.4.1（开发 0.4.2） |
| 文档页 | 112 |
| 内置模板 / 可下载 / 合计 | 23 / 99 / 122 |
| 工具数 | 37 |
| LaTeX 符号 | 236 |
| Preflight 检查 / PDF-UA 规则 | 6 / 106 |
| AI provider / CLI agent | 11 + 自定义端点 / 14 |
| 内置科研技能 | 12 + Domain shelf |
| 界面语言 / 官网语言 | 2 / 12+ |
| 编译超时 / 通用转换上限 | 300 s / 128 MB |

---

*本报告基于公开信息整理，涉及商业路径与成本结构的段落属分析推断，已在正文标注。*
