"""V2: four workspaces, one compact navigation sidebar, global copilot/notes dock."""
from pathlib import Path
from html import escape
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent
W,H = 1600,1000
FONT='C:/Windows/Fonts/msyh.ttc'
BOLD='C:/Windows/Fonts/msyhbd.ttc'
MONO='C:/Windows/Fonts/consola.ttf'
INK='#282828'; MUTED='#777777'; LINE='#d3d3d3'; BG='#f7f7f7'
PAGES=[]

class Page:
    def __init__(self,title,subtitle):
        self.im=Image.new('RGB',(W,H),'white');self.d=ImageDraw.Draw(self.im)
        self.svg=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}"><rect width="100%" height="100%" fill="white"/>']
        self.text(20,14,title,23,True);self.text(20,48,subtitle,13,color=MUTED)
    def rect(self,x,y,w,h,fill='white',stroke=None):
        self.d.rectangle((x,y,x+w,y+h),fill=fill,outline=stroke)
        self.svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" stroke="{stroke or fill}"/>')
    def line(self,x,y,r,b,color=LINE,width=1):
        self.d.line((x,y,r,b),fill=color,width=width)
        self.svg.append(f'<path d="M{x} {y} L{r} {b}" stroke="{color}" stroke-width="{width}"/>')
    def text(self,x,y,t,size=14,bold=False,color=INK,mono=False):
        f=ImageFont.truetype(MONO if mono else BOLD if bold else FONT,size)
        self.d.text((x,y),t,font=f,fill=color)
        self.svg.append(f'<text x="{x}" y="{y+size}" font-family="{("Consolas" if mono else "Microsoft YaHei")},sans-serif" font-size="{size}" font-weight="{700 if bold else 400}" fill="{color}">{escape(t)}</text>')
    def lines(self,x,y,items,size=14,step=26,color=INK,mono=False):
        for i,t in enumerate(items):self.text(x,y+i*step,t,size,color=color,mono=mono)
    def button(self,x,y,w,label,active=False):
        self.rect(x,y,w,27,'#eaeaea' if active else 'white',LINE)
        self.text(x+10,y+5,label,12)
    def save(self,name,caption):
        self.text(20,950,caption,14,color=MUTED)
        self.im.save(OUT/f'{name}.png')
        (OUT/f'{name}.svg').write_text('\n'.join(self.svg+['</svg>']),encoding='utf-8')
        PAGES.append(self.im)

def icon(p,x,y,kind):
    if kind==0:
        for dx,dy in [(0,0),(8,0),(0,8),(8,8)]:p.rect(x+dx,y+dy,5,5,'white','#555555')
    elif kind==1:
        p.rect(x,y,13,15,'white','#555555');p.line(x+3,y+5,x+10,y+5,'#777777');p.line(x+3,y+9,x+10,y+9,'#777777')
    elif kind==2:
        p.line(x+5,y,x,y+7,'#555555');p.line(x,y+7,x+5,y+14,'#555555');p.line(x+9,y,x+14,y+7,'#555555');p.line(x+14,y+7,x+9,y+14,'#555555')
    else:
        p.line(x,y+14,x+13,y+1,'#555555',2);p.line(x,y+14,x+6,y+14,'#555555')

def shell(p,active=0,secondary=(),selected=0,dock='ai',context='项目：示例研究',home=False):
    p.rect(20,80,1560,848,'white','#bdbdbd')
    p.line(20,123,1580,123);p.line(20,904,1580,904)
    p.text(35,92,'Scientify',15,True)
    p.text(140,93,'>  我的空间' if home else '>  我的空间  >  示例研究',13)
    p.text(738,94,'搜索项目与资料…',12,color=MUTED)
    p.button(1347,87,98,'AI 助手',dock=='ai')
    p.button(1455,87,106,'研究笔记',dock in ('notes','list'))
    p.rect(20,124,248,779,BG);p.line(268,123,268,904)
    if home:
        p.text(38,147,'工作空间',12,True,color=MUTED)
        p.rect(28,180,230,31,'#e8e8e8');p.text(42,187,'我的项目',14,True)
        p.lines(42,232,['已收藏','已归档'],14,37)
        p.line(36,320,252,320);p.text(38,342,'团队空间',12,True,color=MUTED)
        p.lines(42,382,['计算研究组','＋ 创建或加入团队'],14,37)
    else:
        for i,label in enumerate(['概览','文献','实验','论文']):
            x=20+i*62;icon(p,x+24,134,i);p.text(x+17,154,label,13,bold=i==active)
            if i==active:p.line(x+7,176,x+55,176,INK,2)
        p.line(20,179,268,179)
        for i,label in enumerate(secondary):
            x=34+i*(230//max(len(secondary),1));p.text(x,191,label,13,bold=i==selected,color=INK if i==selected else MUTED)
            if i==selected:p.line(x,216,x+len(label)*13,216,INK,2)
        if secondary:p.line(20,219,268,219)
    p.text(38,867,'个人    设置    帮助',12,color=MUTED)
    p.text(35,911,'已保存',11,color=MUTED);p.text(1420,911,'任务 0  ·  本地',11,color=MUTED)
    end=1244 if dock else 1580
    if dock:
        p.line(1244,123,1244,904,'#aaaaaa')
        p.text(1261,136,'AI 助手',13,bold=dock=='ai',color=INK if dock=='ai' else MUTED)
        p.text(1354,136,'研究笔记',13,bold=dock!='ai',color=INK if dock!='ai' else MUTED)
        p.text(1500,136,'…    ×',15,color=MUTED)
        p.line(1244,160,1580,160)
        p.line(1259 if dock=='ai' else 1351,159,1323 if dock=='ai' else 1421,159,INK,2)
        if dock=='ai':
            p.text(1261,175,'当前工作内容',11,True,color=MUTED)
            p.text(1261,197,context,12)
            p.text(1261,221,'跟随当前内容  ·  可固定或移除材料',11,color=MUTED)
            p.line(1259,248,1564,248)
            p.text(1261,268,'你',12,True)
            p.lines(1261,296,['请结合当前材料，','帮我梳理下一步需要检查的问题。'],14)
            p.text(1261,380,'助手',12,True)
            p.lines(1261,408,['可以先核对以下两点：','','1. 当前结果依据哪些材料？','2. 还有哪些条件尚未验证？','','引用与材料定位显示在回答末尾。'],14,29)
            p.text(1261,629,'复制    保存为笔记',12,color=MUTED)
            p.rect(1259,773,305,108,'white','#aaaaaa')
            p.text(1271,786,'继续提问…',14,color=MUTED)
            p.text(1271,849,'＋ 材料    模型',12,color=MUTED);p.text(1500,849,'发送 ↑',12)
        elif dock=='notes':
            p.text(1261,175,'‹ 笔记列表',12);p.text(1486,175,'＋ 新建',12)
            p.text(1261,212,'一次观察与待验证的问题',16,True)
            p.text(1261,245,'示例研究  /  自动保存',11,color=MUTED)
            p.line(1259,277,1564,277)
            p.text(1261,294,'B    I    列表    引用',12,color=MUTED)
            p.lines(1261,342,['观察','','目前看到的差异可能与输入条件有关。','需要补充一次对照，再判断是否稳定。','','待验证','','□ 检查配置与数据版本','□ 补充另一组随机种子'],14, thirty())
            p.line(1259,769,1564,769)
            p.text(1261,786,'来源（创建时关联）',11,True,color=MUTED)
            p.text(1261,811,context,12)
            p.text(1261,858,'定位来源    添加关联',12,color=MUTED)
        else:
            p.text(1261,176,'个人收集箱 / 全部笔记' if home else '示例研究 / 全部笔记',12);p.text(1490,176,'＋ 新建',12)
            p.rect(1259,209,305,29,'white',LINE);p.text(1269,215,'搜索笔记…',12,color=MUTED)
            for i,(t,sub) in enumerate([('一次观察与待验证的问题','阅读材料 · 刚刚'),('运行对比小结','实验 #03 · 今天'),('论文讨论段落的思路','discussion.tex · 昨天')]):
                yy=269+i*86;p.text(1261,yy,t,14,bold=i==0);p.text(1261,yy+29,sub,12,color=MUTED);p.line(1259,yy+67,1564,yy+67)
    return end

def thirty():return 30

def tabs(p,labels,end,tools='',active=0):
    p.rect(269,124,end-269,33,'#fafafa')
    x=283
    for i,label in enumerate(labels):
        p.text(x,133,label,12,bold=i==active,color=INK if i==active else MUTED)
        if i==active:p.line(x-7,156,x+len(label)*8+9,156,INK,2)
        x+=len(label)*8+46
    p.line(268,157,end,157)
    if tools:p.text(284,168,tools,12,color=MUTED)
    p.line(268,189,end,189)

def side(p,heading,items,start=242):
    p.text(36,start,heading,11,True,color=MUTED)
    for i,t in enumerate(items):
        yy=start+32+i*29
        if t.startswith('*'):
            p.rect(28,yy-3,232,27,'#e9e9e9');t=t[1:]
        p.text(42,yy,t,13)

def code(p,x,y,w,kind='python'):
    rows=['import torch','from model import Encoder','','def evaluate(model, loader):','    model.eval()','    scores = []','','    for batch in loader:','        output = model(batch)','        scores.append(output)','','    return torch.cat(scores)'] if kind=='python' else ['\\documentclass{article}','\\usepackage{graphicx}','','\\title{Research notes}','\\begin{document}','\\maketitle','','\\section{Introduction}','Describe the research question.','','\\section{Method}','Define the evaluation protocol.','','\\end{document}']
    for i,t in enumerate(rows):
        yy=y+i*27;p.text(x+12,yy,str(i+1),12,color='#999999',mono=True)
        p.text(x+49,yy,t,13,color=INK if i not in [2,6] else MUTED,mono=True)
    p.rect(x+43,y+len(rows)*27,w-53,25,'#f5f5f5')

def paper(p,x,y,w,h,title='Research notes',translate=False):
    p.rect(x,y,w,h,'white',LINE)
    p.text(x+35,y+39,title,18,True)
    p.text(x+35,y+78,'Illustrative document · layout study',11,color=MUTED)
    p.text(x+35,y+128,'1  Introduction',14,True)
    for i in range(16):
        yy=y+170+i*22
        if i==5:p.text(x+35,yy,'2  Method',14,True);continue
        width=(w- seventy())*[1,.94,.98,.72][i%4]
        p.line(x+35,yy+8,x+35+width,yy+8,'#bbbbbb')
    p.text(x+w/2,y+h-39,'1',11,color=MUTED)

def seventy():return 70

p=Page('01 / 项目管理','空间 → 项目 → 工作现场；全局助手与笔记仍可使用。线稿内为示意数据。')
end=shell(p,home=True,dock='list')
p.text(294,147,'我的项目',18,True);p.button(1118,139,103,'＋ 新建项目')
p.text(294,193,'全部项目    收藏    归档',13);p.text(984,193,'搜索    排序    列表',12,color=MUTED)
p.line(292,226,1220,226)
p.text(302,242,'项目名称',12,color=MUTED);p.text(802,242,'阶段',12,color=MUTED);p.text(1005,242,'最近打开',12,color=MUTED)
for i,(name,desc) in enumerate([('示例研究','问题与实验材料'),('方法复现','文献、代码与运行记录'),('论文修改','稿件与审稿意见')]):
    yy=285+i*87;p.text(302,yy,name,15,True);p.text(302,yy+29,desc,12,color=MUTED);p.text(802,yy,'进行中',13);p.text(1005,yy,'今天',13);p.text(1188,yy,'…',15);p.line(292,yy+68,1220,yy+68)
p.save('01-projects','项目集合采用紧凑列表；无项目上下文时，右侧显示个人笔记收集箱或明确选择的项目。')

p=Page('02 / 项目概览','Dashboard 只聚合信息与入口；不为每块摘要增加独立导航页。')
end=shell(p,0,dock='ai')
side(p,'当前项目',['示例研究','项目设置…'],205)
p.text(301,151,'示例研究',21,True);p.text(301,191,'研究问题与当前阶段的简短描述',13,color=MUTED)
p.line(300,232,1214,232)
p.text(300,255,'继续工作',14,True)
p.lines(300,297,['文献  →  上次阅读的材料','实验  →  evaluate.py','论文  →  main.tex'],14,39)
p.line(300,433,1214,433);p.text(300,457,'待办',14,True);p.text(808,457,'最近活动',14,True)
p.lines(300,505,['□ 补充对照实验','□ 整理方法部分的引用','□ 检查上次运行结果'],14,40)
p.lines(808,505,['09:30  保存阅读小结','昨天    完成一次运行','昨天    修改论文方法部分'],13,40,color=MUTED)
p.save('02-overview','概览负责看状态、继续工作；AI、研究笔记始终属于右侧全局辅助栏。')

def literature(mode='local',dock='ai',reading=False):
    p=Page('文献区 / '+('阅读与笔记' if dock=='notes' else '阅读与助手' if reading else '订阅' if mode=='feeds' else '本地文献'),'文献、订阅与阅读在同一工作区完成；导入、翻译和提问不增加导航层级。')
    end=shell(p,1,['本地文献','订阅'],1 if mode=='feeds' else 0,dock,context='文献 A · 第 3 页' if reading else '文献区 / 当前列表')
    side(p,'订阅源' if mode=='feeds' else '文献集合',['*全部更新','arXiv / 研究主题','期刊更新','＋ 添加订阅'] if mode=='feeds' else ['*当前项目','全部文献','待阅读','已收藏','方法相关'])
    if reading:
        tabs(p,['文献列表','文献 A.pdf  ×'],end,'← 列表    3 / 12    － 100% ＋    查找    高亮    翻译',active=1)
        p.rect(269,190,975,714,'#f4f4f4')
        paper(p,472,213,567,667,'A research document')
        p.rect(507,453,470,25,'#e6e6e6')
        p.text(511,459,'选中段落 → 提问 / 记笔记 / 翻译',12)
        side(p,'当前文献大纲',['1  Introduction','2  Method','3  Results'],560)
    else:
        tabs(p,['订阅更新' if mode=='feeds' else '本地文献'],end,'搜索文献…       筛选    排序                                  '+('刷新    管理订阅' if mode=='feeds' else '＋ 导入'))
        p.text(290,211,'标题 / 作者',12,color=MUTED);p.text(913,211,'来源 / 年份',12,color=MUTED);p.text(1104,211,'状态',12,color=MUTED)
        for i in range(7):
            yy=247+i*69
            if i==0:p.rect(269,yy-7,975,62,'#f0f0f0')
            p.text(290,yy,f'文献 {chr(65+i)}：研究方法与实验结果',14,bold=i==0)
            p.text(290,yy+26,'作者信息 / 简短摘要片段（示意）',12,color=MUTED)
            p.text(913,yy,'arXiv / 2026',12);p.text(1104,yy,'未收录' if mode=='feeds' else '待读',12)
            p.line(288,yy+54,1225,yy+54)
        p.line(268,785,1244,785);p.text(290,805,'当前选择：文献 A',13,True)
        p.text(290,842,'摘要 / 元数据就地展开，详细阅读在中央内容标签中打开。',12,color=MUTED)
        p.button(1109,802,112,'加入文献库' if mode=='feeds' else '打开阅读')
    return p

def forty():return 40

p=literature();p.save('03-library','左侧只有“本地文献 / 订阅”两个二级入口；中央列表使用行和分隔线，不重复套卡片。')
p=literature('feeds');p.save('04-subscriptions','订阅更新与本地收藏共享同一文献身份；加入后可继续阅读，保持原订阅筛选。')
p=literature(reading=True);p.save('05-reader-ai','PDF 在中央，AI 独立留在右侧；选中原文后就地提问，原文位置不变。')
p=literature(reading=True,dock='notes');p.save('06-reader-notes','只切换右侧辅助栏：原文保持不动，笔记可连续编辑并记录来源。')

p=Page('07 / 实验管理 · 文件','VS Code 式文件工作流：选择代码 → 编辑 → 运行 → 查看输出；AI 独立位于右侧。')
end=shell(p,2,['文件','运行','版本'],dock='ai',context='evaluate.py · 选中 8–10 行')
side(p,'项目文件',['v  src','    model.py','*    evaluate.py','v  configs','    baseline.yaml','>  data','>  outputs'])
side(p,'大纲',['evaluate(model, loader)'],625)
tabs(p,['evaluate.py  ×','baseline.yaml  ×'],end,'src / evaluate.py                                              运行    查找    更多')
code(p,280,214,943)
p.line(268,702,1244,702);p.text(284,715,'输出    问题    终端',12,True);p.text(1168,715,'收起',12,color=MUTED)
p.lines(284,754,['> python src/evaluate.py','Loading configuration: baseline.yaml','Run completed. Outputs saved.'],13,27,color=MUTED,mono=True)
p.save('07-experiment-code','文件、运行与版本属于同一实验工作区；输出面板仅占中央底部，不挤进全局辅助栏。')

p=Page('08 / 实验管理 · 运行','运行详情与研究笔记并排；代码版本、配置和结果通过当前运行关联。')
end=shell(p,2,['文件','运行','版本'],1,'notes',context='运行 #03 · baseline.yaml')
side(p,'运行记录',['*#03  baseline',' #02  baseline',' #01  initial'])
tabs(p,['运行 #03','对比结果'],end,'配置    日志    指标    产物                                 关联版本    对比')
p.text(296,220,'运行 #03',20,True);p.text(296,257,'已完成    ·    baseline.yaml    ·    commit: 示例版本',13,color=MUTED)
p.line(295,303,1219,303);p.text(296,328,'指标',14,True);p.text(681,328,'值',12,color=MUTED);p.text(902,328,'与上次运行',12,color=MUTED)
for i,t in enumerate(['accuracy','loss','elapsed']):
    yy=378+i*54;p.text(296,yy,t,14);p.text(681,yy,'—',14);p.text(902,yy,'等待实际数据',12,color=MUTED);p.line(295,yy+37,1219,yy+37)
p.line(268,702,1244,702);p.text(285,717,'运行日志',12,True);p.text(285,763,'此处显示所选运行的真实输出。',13,color=MUTED)
p.save('08-experiment-run','小结写入右侧研究笔记；不会因为切换文件或实验而替换正在编辑的笔记。')

for dock,name in [('ai','09-writing-ai'),(None,'10-writing-focus')]:
    p=Page(('09' if dock else '10')+' / 论文撰写'+(' · AI 打开' if dock else ' · 专注布局'),'Oleafly 式源文件—编辑—渲染关系：预览始终属于中央呈现层。')
    end=shell(p,3,['文件','引用'],dock=dock,context='main.tex · Introduction')
    side(p,'稿件文件',['*main.tex','references.bib','>  sections','>  figures'])
    side(p,'文档大纲',['1  Introduction','2  Method','3  Results'],579)
    mid=int(268+(end-268)*.52)
    tabs(p,['main.tex  ×','references.bib  ×'],end,'源码 / 分栏 / 预览                                        编译    导出')
    p.line(mid,189,mid,904);code(p,280,215,mid-292,'latex')
    p.rect(mid+1,190,end-mid-1,714,'#f4f4f4')
    paper(p,mid+23,219,end-mid-46,647)
    p.save(name,'AI 打开时，源文与渲染仍可并排；收起右侧后中央区域自然扩展。')

p=Page('11 / 全局研究笔记 · 查找与继续','笔记使用同一个右侧辅助栏：列表、搜索、编辑原位切换，不新增一级工作区。')
end=shell(p,0,dock='list');side(p,'当前项目',['示例研究','项目设置…'],205)
p.text(300,157,'示例研究',21,True);p.text(300,208,'继续阅读    →    继续实验    →    继续撰写',14)
p.line(299,252,1216,252);p.text(300,276,'最近笔记',14,True)
p.lines(300,322,['一次观察与待验证的问题  →','运行对比小结  →','论文讨论段落的思路  →'],14,43)
p.text(300,526,'点击概览中的笔记入口，会在右侧打开对应笔记。',13,color=MUTED)
p.save('11-notes-list','右侧入口在任意工作区可用；“AI 助手 / 研究笔记”互切保留各自状态。')

sheet=Image.new('RGB',(1600,4*350),'#e5e5e5')
for i,im in enumerate(PAGES):sheet.paste(im.resize((520,325),Image.Resampling.LANCZOS),(8+(i%3)*533,8+(i//3)*350))
sheet.save(OUT/'00-overview.png')
print(f'Generated {len(PAGES)} wireframes (PNG and SVG).')
