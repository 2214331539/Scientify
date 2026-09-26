"""Generate editable SVG and PNG layout wireframes. No application data is read."""
from pathlib import Path
from html import escape
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent
W, H = 1440, 920
FONT = 'C:/Windows/Fonts/msyh.ttc'
BOLD = 'C:/Windows/Fonts/msyhbd.ttc'
INK, MUTED, LINE, FILL = '#222222', '#686868', '#a0a0a0', '#f3f3f3'

class Canvas:
    def __init__(self, title, subtitle):
        self.im = Image.new('RGB', (W, H), 'white')
        self.d = ImageDraw.Draw(self.im)
        self.svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">', '<rect width="100%" height="100%" fill="white"/>']
        self.text(24, 16, title, 23, bold=True)
        self.text(24, 49, subtitle, 13, MUTED)

    def rect(self, box, fill='white', stroke=LINE, dash=False):
        x,y,r,b = box
        self.d.rectangle(box, fill=fill, outline=stroke, width=1)
        dashed = ' stroke-dasharray="5 4"' if dash else ''
        self.svg.append(f'<rect x="{x}" y="{y}" width="{r-x}" height="{b-y}" fill="{fill}" stroke="{stroke}"{dashed}/>')

    def line(self, x,y,r,b, color=LINE):
        self.d.line((x,y,r,b), fill=color, width=1)
        self.svg.append(f'<path d="M{x} {y} L{r} {b}" fill="none" stroke="{color}"/>')

    def text(self, x,y,value, size=15, color=INK, bold=False):
        font = ImageFont.truetype(BOLD if bold else FONT, size)
        self.d.text((x,y), value, fill=color, font=font)
        weight = '700' if bold else '400'
        self.svg.append(f'<text x="{x}" y="{y+size}" font-family="Microsoft YaHei, sans-serif" font-size="{size}" font-weight="{weight}" fill="{color}">{escape(value)}</text>')

    def rows(self, x,y,width,count=5,step=47):
        for i in range(count):
            yy=y+i*step
            self.rect((x,yy,x+width,yy+step-8), '#fafafa', '#d0d0d0')
            self.line(x+15, yy+14, x+width*.63, yy+14, '#c6c6c6')
            self.line(x+15, yy+25, x+width*.4, yy+25, '#dedede')

    def panel(self, box,title,desc=''):
        self.rect(box)
        x,y,r,b=box
        self.rect((x,y,r,y+38),FILL)
        self.text(x+14,y+9,title,15,bold=True)
        if desc: self.text(x+18,y+60,desc,14,MUTED)

    def save(self,name,foot):
        self.text(24,880,foot,14,MUTED)
        self.svg.append('</svg>')
        self.im.save(OUT/f'{name}.png')
        (OUT/f'{name}.svg').write_text('\n'.join(self.svg),encoding='utf-8')
        return self.im

NAV=['项目概览','研究工作台','文献库','论文订阅区','实验与代码','AI 助手']

def shell(c, active, sections, selected=0, resources='资源 / 对象列表', companion=False):
    c.rect((20,80,1420,860))
    c.rect((20,80,1420,127),FILL)
    c.text(36,93,'← 项目集合    /    当前空间    /    当前项目 · 切换',16,bold=True)
    c.text(1080,94,'全局搜索    布局    通知    设置',14)
    c.rect((20,127,124,832),'#f7f7f7')
    for i,name in enumerate(NAV):
        yy=147+i*82
        if i==active:
            c.rect((25,yy-5,119,yy+60),'#e4e4e4','#aaaaaa')
            c.rect((25,yy-5,28,yy+60),'#333333','#333333')
        c.rect((60,yy+3,80,yy+23),'white','#707070')
        c.text(33 if len(name)>4 else 42,yy+32,name,13,bold=i==active)
    c.text(45,786,'帮助',13,MUTED)
    c.rect((124,127,354,832),'#fbfbfb')
    c.text(140,143,NAV[active]+' / 二级导航',15,bold=True)
    for i,name in enumerate(sections):
        yy=181+i*35
        if i==selected: c.rect((134,yy-3,344,yy+27),'#e8e8e8','#e8e8e8')
        c.text(148,yy,name,14,bold=i==selected)
    start=193+len(sections)*35
    c.line(124,start,354,start)
    c.text(140,start+14,resources,14,bold=True)
    if resources!='无需资源选择时收起': c.rows(140,start+49,198,4,45)
    c.rect((354,127,1420,832),'white')
    c.rect((20,832,1420,860),FILL)
    c.text(36,838,'保存状态 / 后台任务',12)
    c.text(1080,838,'当前对象状态    ·    本地工作区',12)

def content_header(c, title, tools='当前视图操作    /    更多'):
    c.rect((354,127,1420,166),FILL)
    c.text(372,137,title,15,bold=True)
    c.text(1120,138,tools,13)

def document(c,box,label='正文内容',code=False):
    x,y,r,b=box
    c.text(x+22,y+18,label,16,bold=True)
    for i in range(12):
        yy=y+60+i*28
        if yy>b-20: break
        if code: c.text(x+16,yy-8,str(i+1),11,'#999999')
        start=x+48 if code else x+22
        length=(r-start-25)*([.82,.65,.9,.55,.7][i%5])
        c.line(start, yy,start+length,yy,'#c8c8c8')

images=[]

c=Canvas('01  登录后 / 项目管理','入口场景 · 选择空间 → 查找项目 → 进入项目工作台；当前本地版也可直接到达此页')
c.rect((20,80,1420,860))
c.rect((20,80,258,860),'#f5f5f5')
c.text(42,104,'Scientify',21,bold=True)
c.text(42,159,'个人资料 / 账号',16)
c.line(20,206,258,206)
for i,label in enumerate(['我的工作空间','团队空间 A','团队空间 B','创建 / 加入团队']):
    yy=225+i*50
    if i==0:c.rect((30,yy-4,246,yy+33),'#e3e3e3','#e3e3e3')
    c.text(44,yy,label,15,bold=i==0)
c.text(42,806,'设置    帮助',14)
c.rect((258,80,1420,127),FILL)
c.text(280,95,'当前空间 / 项目集合',16,bold=True)
c.text(1218,96,'通知    账号',14)
c.text(280,155,'项目',23,bold=True)
c.rect((1232,149,1396,189),FILL);c.text(1251,159,'＋ 新建项目',15)
c.rect((280,209,1396,250),FILL)
c.text(296,220,'全部 / 收藏 / 归档',14)
c.text(912,220,'搜索项目       排序       列表 / 网格',14)
for i in range(3):
    for j in range(2):
        x=280+i*377;y=276+j*242
        c.panel((x,y,x+360,y+215),'项目名称 / 进入项目','研究问题或简短描述')
        c.text(x+18,y+131,'阶段 / 最近活动',14,MUTED)
        c.line(x,y+174,x+360,y+174)
        c.text(x+18,y+185,'更新时间',12,MUTED)
        c.text(x+245,y+185,'收藏 / 更多',12)
c.text(280,788,'空状态使用同一区域：一句说明 + 新建项目入口',14,MUTED)
images.append(c.save('01-project-library','项目管理层使用空间导航；打开项目后整体切换为下图的项目工作台框架。'))

c=Canvas('02  项目概览','工作台默认入口 · 内容为结构占位，具体概览指标和组件后续确定')
shell(c,0,['项目总览','任务与里程碑','项目动态','成员与分工','项目设置'],resources='无需资源选择时收起')
content_header(c,'当前项目 / 项目总览')
c.panel((374,186,1400,322),'项目上下文','研究目标 / 当前阶段 / 负责人（占位）')
c.panel((374,342,985,810),'主要工作区域','任务、阶段或进度的主视图（待定）');c.rows(394,437,571,6,48)
c.panel((1005,342,1400,810),'辅助信息区域','近期动态或关联内容（待定）');c.rows(1025,437,355,5,52)
images.append(c.save('02-overview','一级导航选中“项目概览”；二级切换任务视图；概览内容使用连续分区。'))

c=Canvas('03  研究工作台 / 编辑与预览','编辑场景 · 资源树 → 文档标签 → 编辑正文 → 预览结果')
shell(c,1,['文件与编辑','研究记录','历史版本'],resources='项目文件树 / 大纲')
content_header(c,'文档 A  ×     文档 B  ×     ＋','布局    保存    更多')
c.panel((354,166,974,651),'当前文件路径 / 编辑工具','')
document(c,(354,204,974,650),'代码 / Markdown / LaTeX 编辑器',True)
c.panel((984,166,1420,651),'配套面板：预览 / AI','')
document(c,(1004,224,1400,630),'预览结果')
c.panel((354,662,1420,832),'输出面板：问题 / 编译日志       收起','日志、错误位置、任务状态（占位）')
c.text(375,771,'点击诊断可定位到当前文件与行号',13,MUTED)
images.append(c.save('03-research','中央区最多两个主要内容面板；AI 与预览共用配套面板；底部输出按需展开。'))

c=Canvas('04  文献库 / 管理视图','集合场景 · 选择文献范围 → 筛选列表 → 选择文献 → 查看详情或进入阅读')
library=['信息管理','文献导入','PDF 阅读','实时翻译','AI 助手提问','引用管理']
shell(c,2,library,resources='集合 / 标签 / 项目范围')
content_header(c,'文献列表','导入    筛选    更多')
c.rect((374,186,1400,230),FILL);c.text(390,199,'搜索 / 阅读状态 / 排序',14)
c.panel((374,246,1020,812),'文献列表 / 可切换排序','');c.rows(392,302,610,8,54)
c.panel((1040,246,1400,812),'所选文献详情','元数据 / 关联项目（占位）');c.rows(1060,363,320,4,55)
c.rect((1060,724,1380,770),FILL);c.text(1152,737,'打开阅读',16,bold=True)
images.append(c.save('04-library','当前对象由列表选择；阅读、翻译和问答沿用同一文献身份。'))

for idx, selected, companion_title, title in [
    (5,2,'笔记 / 文献大纲','PDF 阅读'),
    (6,3,'对应译文 / 目标语言','实时翻译'),
    (7,4,'当前文献问答 / 来源','AI 助手提问')]:
    c=Canvas(f'{idx:02d}  文献库 / {title}','连续工作场景 · 切换二级任务，保留同一篇文献和阅读位置')
    shell(c,2,library,selected,resources='当前文献 / 文献集合')
    content_header(c,'当前文献 A  ×     文献 B  ×','定位    布局    更多')
    c.panel((354,166,996,812),'PDF 原文       页码 / 缩放 / 搜索','')
    c.rect((408,222,942,779),'#fcfcfc')
    document(c,(431,244,919,750),'论文原文 / 当前页')
    c.rect((452,449,873,485),'#e6e6e6','#d0d0d0')
    c.text(465,457,'当前选中段落',14)
    c.panel((1006,166,1420,812),companion_title,'')
    if idx==7:
        c.rows(1026,229,374,3,104)
        c.text(1026,581,'引用来源 → 跳回原文',14,MUTED)
        c.rect((1026,696,1400,790),'#fafafa');c.text(1042,712,'基于当前文献提问…',14,MUTED)
        c.text(1298,760,'发送 →',14)
    else: document(c,(1026,217,1400,785),'阅读笔记' if idx==5 else '译文与原文对照')
    images.append(c.save(f'{idx:02d}-library-'+{5:'reading',6:'translation',7:'questions'}[idx],
        '外层框架保持不变；任务改变配套内容，原文阅读位置和选中段落继续保留。'))

c=Canvas('08  论文订阅区','发现流程 · 选择订阅源 → 浏览更新 → 判断是否加入文献库')
shell(c,3,['论文更新','订阅管理','论文筛选','研究简报'],resources='订阅源 / 研究方向')
content_header(c,'论文更新','刷新    筛选    更多')
c.panel((374,186,959,812),'更新列表','');c.rows(394,248,545,7,72)
c.panel((979,186,1400,812),'选中论文 / 摘要与来源','元数据和摘要内容（占位）')
document(c,(999,296,1380,668),'摘要预览')
c.rect((999,737,1380,788),FILL);c.text(1019,753,'忽略    稍后处理    加入文献库 →',14)
images.append(c.save('08-subscriptions','订阅区负责发现和筛选；入库后跳转文献库继续阅读，避免维护第二套文献记录。'))

c=Canvas('09  实验与代码管理','追踪流程 · 选择实验或仓库 → 查看当前任务视图 → 定位结果与代码版本')
shell(c,4,['实验列表','配置与环境','运行与日志','代码版本','指标与比较','产物与复现'],resources='实验 / 仓库对象列表')
content_header(c,'当前实验 / 当前视图','比较    关联代码    更多')
c.panel((374,186,1400,293),'所选实验上下文','实验身份 / 状态 / 关联版本（占位）')
c.panel((374,312,1400,621),'中央任务视图','配置、差异或指标视图按二级导航切换，详细字段待定')
c.rows(394,421,985,3,54)
c.panel((374,642,1400,812),'运行输出 / 日志（可收起）','归属于当前实验的任务输出（占位）')
images.append(c.save('09-experiments','在此管理运行与版本；需要撰写代码时携带文件引用跳转研究工作台。'))

c=Canvas('10  AI 助手','跨材料任务 · 选择或继续会话 → 选择依据 → 处理问题与结果')
shell(c,5,['项目问答','资料与上下文','任务模板','会话与成果','模型配置'],resources='当前项目的会话列表')
content_header(c,'当前会话','模型    布局    更多')
c.panel((374,186,1010,812),'项目对话','');c.rows(396,245,592,3,105)
c.rect((396,688,988,791),'#fafafa');c.text(414,704,'当前上下文摘要 / 输入问题…',14,MUTED);c.text(895,759,'发送 →',14)
c.panel((1030,186,1400,812),'上下文 / 引用来源 / 成果','资料选择与来源定位（占位）');c.rows(1050,303,330,5,61)
images.append(c.save('10-assistant','一级 AI 助手处理跨模块任务；嵌入文献或编辑页的问答与此共用会话服务。'))

c=Canvas('11  全局设置 / 系统页面','全局工具场景 · 设置沿用应用框架，关闭后返回原项目与编辑现场')
shell(c,1,['文件与编辑','研究记录','历史版本'],resources='原工作区状态保留')
c.rect((280,151,1340,790),'#ffffff','#555555')
c.rect((280,151,1340,199),FILL);c.text(300,165,'应用设置',17,bold=True);c.text(1238,165,'关闭 ×',14)
c.rect((280,199,518,790),'#f7f7f7')
for i,label in enumerate(['账号与团队','外观与交互','模型与连接','数据与备份','扩展与关于']):
    c.text(304,227+i*48,label,15,bold=i==1)
c.text(549,227,'当前设置分类',20,bold=True)
c.rows(549,292,749,5,77)
c.text(550,740,'即时生效或显式保存，由具体设置项确定',13,MUTED)
images.append(c.save('11-settings','全局设置采用集中式对话窗口；不会成为第七个一级工作区。'))

thumbs=Image.new('RGB',(1440,4*330),'#dddddd')
draw=ImageDraw.Draw(thumbs)
for i,im in enumerate(images):
    preview=im.resize((468,299),Image.Resampling.LANCZOS)
    x=8+(i%3)*480;y=8+(i//3)*330
    thumbs.paste(preview,(x,y))
thumbs.save(OUT/'00-wireframe-overview.png')
print(f'Generated {len(images)} PNG + SVG wireframes and a contact sheet in {OUT}')
