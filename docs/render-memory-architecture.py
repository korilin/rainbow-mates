from pathlib import Path
from math import hypot
from PIL import Image, ImageDraw, ImageFont

W,H=1970,5120
S=2
bg='#F7F8FC'
ink='#192941'
gray='#45566D'
light='#596C85'
blue='#355C9A'
purple='#6245A1'
gold='#805019'
green='#216B5E'
red='#875645'
im=Image.new('RGB',(W*S,H*S),bg)
d=ImageDraw.Draw(im)
fontdir=Path('/System/Library/Fonts')
fonts={}
def pix(values): return tuple(round(v*S) for v in values)
def font(size,bold=False):
    k=(size,bold)
    if k not in fonts:
        f='STHeiti Medium.ttc' if bold else 'STHeiti Light.ttc'
        fonts[k]=ImageFont.truetype(str(fontdir/f),size*S)
    return fonts[k]
def text(x,y,label,size=21,color=ink,bold=False,anchor='lt'):
    d.text(pix((x,y)),label,font=font(size,bold),fill=color,anchor=anchor)
def box(bounds,fill,edge=None,r=18,w=1):
    d.rounded_rectangle(pix(bounds),r*S,fill=fill,outline=edge,width=w*S)
def line(pts,color,w=2):
    d.line([pix(p) for p in pts],fill=color,width=w*S)
def arrow(pts,color=blue,w=3,dash=False):
    for a,b in zip(pts,pts[1:]):
        if dash:
            dx,dy=b[0]-a[0],b[1]-a[1]
            length=hypot(dx,dy)
            if not length: continue
            for i in range(0,int(length),15):
                j=min(i+7,length)
                line([(a[0]+dx*i/length,a[1]+dy*i/length),
                      (a[0]+dx*j/length,a[1]+dy*j/length)],color,w)
        else:
            line([a,b],color,w)
    a,b=pts[-2:]
    length=hypot(b[0]-a[0],b[1]-a[1])
    dx,dy=(b[0]-a[0])/length,(b[1]-a[1])/length
    d.polygon([pix(p) for p in [b,(b[0]-12*dx+5*dy,b[1]-12*dy-5*dx),
                              (b[0]-12*dx-5*dy,b[1]-12*dy+5*dx)]],fill=color)
def rows(x,y,items,width,size=20,step=31,color=gray):
    for item in items:
        assert font(size).getlength(item)/S <= width,(item,width,font(size).getlength(item)/S)
        text(x,y,item,size,color)
        y+=step
def label(x,y,t,color=gray):
    length=font(17).getlength(t)/S
    box((x-length/2-8,y-4,x+length/2+8,y+23),bg,r=5)
    text(x,y,t,17,color,anchor='mt')
def side(y,title,items):
    text(44,y,title,23,ink,True)
    rows(44,y+42,items,132,17,25,light)
def card(x,y,w,h,title,body,accent=blue,fill='#FFFFFF',edge='#DFE5EF',size=20,step=31):
    box((x,y,x+w,y+h),fill,edge,r=16,w=2)
    text(x+18,y+15,title,23,accent,True)
    rows(x+18,y+54,body,w-36,size,step)
    assert 54+(len(body)-1)*step+size+8<=h,(title,h)
def phase(x,number,title,when,body,why,ref,color,fill,edge):
    w=398
    y=414
    box((x,y,x+w,694),fill,edge,r=21,w=2)
    box((x+19,y+17,x+63,y+56),edge,r=9)
    text(x+41,y+37,number,20,color,True,anchor='mm')
    text(x+76,y+16,title,32,color,True)
    text(x+w-19,y+31,ref,17,color,anchor='rm')
    text(x+20,y+71,when,18,color,True)
    rows(x+20,y+104,body,w-40,20,28)
    box((x+17,630,x+w-17,676),'#FFFFFF',r=10)
    rows(x+29,644,[why],w-58,17,24,color)

X=(190,630,1070,1510)
C=tuple(x+199 for x in X)
text(43,42,'Rainbow Mates  角色记忆架构',51,ink,True)
text(44,114,'横向看记忆怎样流转，纵向看哪些消息、证据和数据支撑每一步。',23,light)
box((1436,50,1920,99),'#EAF1F9',r=12)
text(1453,66,'角色只记得自己实际接触过的内容',20,blue,True)

side(212,'消息时间线',['应用层调度','角色实际经历'])
side(467,'记忆时间线',['按角色持有','循环发生'])
side(794,'规则与证据',['校验与触发','落在各节点'])
side(1038,'持久化',['记忆与任务','分开保存'])
for y in [389,729,967]:
    line([(43,y),(1908,y)],'#E1E7F1',1)

# Application message / execution timeline above the memory lifecycle.
for args in [
 (X[0],191,398,139,'用户消息或任务开始',['同角色的聊天跨会话串行，任务独立','确定本轮目标与该角色实际收到的内容']),
 (X[1],191,398,139,'角色实际接触',['读到本轮消息、引用、交接或工具结果','实际送达后，才可成为记忆来源']),
 (X[2],191,398,139,'执行中出现新线索  [A]',['如测试出现 SQLITE_BUSY','兼容时按新线索调用 memory_search']),
 (X[3],191,398,139,'回复发布与任务接续',['回复和任务结果带上记忆使用回执','新经历交给独立记忆线程  [D]']),
]:
    card(*args,size=19,step=30)
for i in range(3):
    arrow([(X[i]+398,254),(X[i+1],254)],'#7589A7',2)

# Main axis: four linked phases and their design choices.
phase(X[0],'01','检索','开始一轮前，也可在执行中补查',
      ['只查当前角色已有的记忆',
       '内置 BGE-M3 编码问题  [B] [7]',
       '按向量语义相似度取主候选',
       '必要时记忆线程改写、补查和筛选'],
      '全文和字段查询补充精确标识','[1] [2] [3]',blue,'#EAF2FE','#CFDDF5')
phase(X[1],'02','更新','接触新经历，或实际用到旧记忆',
      ['独立记忆线程判断记什么  [D]',
       '角色模型评重要性、复杂度，提炼正文',
       '实际用到旧记忆，次数加 1',
       '正文改动后编码，正文与向量一起发布'],
      '同一角色跨会话用同一个队列','[3] [4]',purple,'#F1EBFA','#DFD2F2')
phase(X[2],'03','衰退','随时间持续计算',
      ['每条记忆按自己的半衰期减半  [C]',
       '半衰期随使用增加，最高 100 天',
       '其他条件相同，复杂度高则忘得快',
       '强度低于 20 或内容失效就退出'],
      '随经历和使用次数改变保留时间','[4]',gold,'#FCF1E4','#EEDABD')
phase(X[3],'04','整理','平时小批处理，每天空闲集中处理',
      ['平时去重、合并新信息，更新索引',
       '空闲时角色归纳零散经历并做取舍',
       '应用清理淡忘条目的正文和向量索引',
       '整理结果供下一轮检索'],
      '即时更新与后台归纳分别调度','[1] [5]',green,'#E8F5EF','#CDE4DA')
for i in range(3):
    arrow([(X[i]+398,550),(X[i+1],550)],'#506696',4)

# Links between the message flow and the primary memory lifecycle.
arrow([(C[0],330),(C[0],414)],blue,3)
arrow([(C[2],330),(C[2],370),(X[0]+285,370),(X[0]+285,414)],'#8B78B2',2,True)
line([(C[1],357),(C[1],383)],bg,12)
arrow([(C[1],330),(C[1],414)],purple,3)
label(C[0]-66,354,'带入本轮线索',blue)
label(C[1]+77,345,'接触后写入',purple)
label(X[2]+82,350,'同轮补查回到检索',purple)

# Vertical supporting blocks and relationships.
card(X[0],762,398,171,'读时信任判定  [2]',[
    '先核对证据来源、有效期与适用版本',
    '相似度高只表相关，来源和冲突仍要核对',
    '旧版本结论最多作为复核线索',
],accent=red,fill='#FFF8F4',edge='#EFDFD8',size=19,step=29)
card(X[1],762,398,171,'写入校验',[
    '证据须来自该角色实际看过的内容',
    '查说话者、事实对象和独立新证据',
    '重复事件不强化，按来源顺序提交',
],accent=purple,fill='#FAF8FE',edge='#E6DDF3',size=19,step=29)
card(X[2],762,398,171,'半衰期与有效使用',[
    '平方基数限制 1–10，半衰期最大 100 天',
    '每次有效使用重置为 100 分',
    '候选曝光照常衰退，同一使用只算一次',
],accent=gold,fill='#FFFAF3',edge='#EFDFCB',size=19,step=29)
card(X[3],762,398,171,'后台调度',[
    '有待整理内容，角色连续空闲 10 分钟',
    '每日集中整理一次，普通增量随时可做',
    '角色负责语义取舍，前台聊天优先',
],accent=green,fill='#F5FBF8',edge='#D8EAE1',size=19,step=29)

arrow([(C[0],762),(C[0],694)],red,3)
arrow([(C[1],694),(C[1],762)],purple,3)
arrow([(C[2],762),(C[2],694)],gold,3)
arrow([(C[3],762),(C[3],694)],green,2,True)
label(C[0]+62,716,'判定后注入',red)
label(C[1]+63,716,'提交操作',purple)
label(C[2]+68,716,'计算强度',gold)
label(C[3]+68,716,'满足条件',green)

# Local stores and the task lane stay distinct.
box((190,1010,1468,1192),'#EAF5F1','#CCDCD6',r=20,w=2)
text(213,1028,'本机 SQLite · 角色正文 + 向量 + 来源 + 计分',26,green,True)
text(1445,1036,'归属由应用校验，不由模型参数指定',18,green,anchor='rt')
small=[
    (215,585,'归属',['角色 ID + 本机用户 ID','同一角色跨会话使用']),
    (608,1044,'经历与向量',['短记忆正文 + 1024 维 Float32 向量','编码器版本、正文版本与词面索引']),
    (1067,1444,'证据、计分与事件',['来源、分数、召回次数与起算时点','待处理经历和去重后的使用回执']),
]
for l,r,k,entries in small:
    box((l,1070,r,1171),'#FFFFFF',r=12)
    text(l+14,1081,k,19,green,True)
    rows(l+14,1115,entries,r-l-28,18,25)
card(X[3],1010,398,182,'独立任务检查点  [6]',[
    '按 taskId 读取已授权的工作状态',
    '保留进度、验证结果和产物引用',
    '换运行时仍可接着做',
],accent=blue,fill='#F1F5FC',edge='#D8E3F4',size=19,step=31)
arrow([(C[0],1010),(C[0],933)],green,3)
arrow([(C[1],933),(C[1],1010)],purple,3)
arrow([(C[2],1010),(C[2],933)],gold,3)
arrow([(X[3],677),(1490,677),(1490,972),(1381,972),(1381,1010)],green,2,True)
label(1475,974,'整理写回记忆库',green)
arrow([(1908,1098),(1935,1098),(1935,279),(1908,279)],'#8297B6',2,True)
label(C[0]+77,951,'读取角色记忆',green)
label(C[1]+76,951,'校验后写入',purple)
label(C[2]+68,951,'读取衰退参数',gold)

# The horizontal architecture above points to these three detailed flow sections.
def section(y,bottom,key,title,kicker,accent):
    box((44,y,1926,bottom),'#FFFFFF','#DCE4F0',r=24,w=2)
    box((72,y+26,125,y+72),accent,r=10)
    text(99,y+50,key,24,'#FFFFFF',True,anchor='mm')
    text(143,y+28,title,34,ink,True)
    text(73,y+88,kicker,20,light)

def chip(x,y,label_value,fill,fg,size=20):
    width=font(size,True).getlength(label_value)/S+30
    box((x,y,x+width,y+38),fill,r=9)
    text(x+15,y+9,label_value,size,fg,True)
    return width

def reference(x,y,w,num,title,urls,reasons,accent):
    box((x,y,x+w,y+154),'#F8FAFD','#E1E7F1',r=15)
    box((x+16,y+14,x+58,y+50),'#E8EDF6',r=8)
    text(x+37,y+32,num,18,accent,True,anchor='mm')
    text(x+73,y+15,title,22,accent,True)
    rows(x+17,y+59,urls,w-34,17,24,gray)
    rows(x+17,y+94,reasons,w-34,19,25,ink)

section(1230,1660,'A','执行到一半，记忆是怎么查回来的？',
        '例子：龙娘在改数据库写入逻辑。任务已经跑起来，这时候测试才报了一个错误。',purple)
sx=(72,536,1000,1464)
for x,title,items in [
    (sx[0],'1. 先做当前任务',['第一轮带任务目标、已有进度','以及一小批可能有关的记忆。']),
    (sx[1],'2. 角色看到新线索',['测试输出 SQLITE_BUSY。','它判断旧记忆可能解释这个报错。']),
    (sx[2],'3. 在原任务里补查',['角色调用只读 memory_search。','交给应用错误码、文件名或现象。']),
    (sx[3],'4. 采用后继续任务',['应用只查龙娘的记忆并核对证据。','龙娘用到旧经验时会登记使用回执。']),
]:
    card(x,1381,425,135,title,items,accent=purple,fill='#F7F3FD',edge='#E5D9F4',size=19,step=27)
for i in range(3):
    arrow([(sx[i]+425,1449),(sx[i+1],1449)],purple,3)
box((73,1544,1894,1630),'#F1EEF9',r=14)
text(92,1561,'谁触发补查',20,purple,True)
text(245,1561,'Rainbow 提供 MCP 工具 memory_search，角色决定何时调用。平台执行编码、检索，结果回原任务。',20,gray)
text(92,1598,'任务进度',20,purple,True)
text(245,1598,'「已经做到第几步」按 taskId 直接读检查点。「以前见过这种报错吗」才查角色记忆。',20,gray)

section(1690,2185,'B','记忆怎么找回来？模型在哪一步参与？',
        '主路径固定为 BGE-M3 向量召回。角色 GPT / DeepSeek 负责理解、评分与整合，BGE-M3 负责编码。',blue)
for x,title,fill,edge,body in [
    (72,'写入 · 先理解，再编码','#EDF4FE','#D2E0F5',[
        '记忆线程调用角色模型提炼经历、比较旧记忆。',
        '决定新增、合并、修订、降级或遗忘。',
        '将最终正文交给内置 BGE-M3，得到语义向量。',
        '校验后原子保存正文、向量、评分和来源。',
    ]),
    (687,'回想 · 同一编码器处理问题','#F4F8FD','#DBE5F2',[
        '你问「几个任务同时保存失败，怎么处理的」。',
        '同一 BGE-M3 将问题转换成查询向量。',
        '只在本角色有效、强度达标的记忆中找相似项。',
        '按余弦相似度取前 20 个，数量是初始参数。',
    ]),
    (1302,'取回 · 按命中 ID 读取原文','#F1EEFC','#DDD3F1',[
        '相似向量定位记忆 ID，例如 M123。',
        '按 ID 读取正文「单写入队列解决写锁冲突」。',
        '附带来源与适用条件，复杂问题由记忆线程筛选。',
        '正文回给原线程，实际用到后登记一次强化。',
    ]),
]:
    box((x,1844,x+592,2069),fill,edge,r=16)
    text(x+20,1862,title,24,blue,True)
    rows(x+21,1909,body,550,19,34)
box((73,2091,1894,2159),'#EAF2FE',r=12)
text(93,2104,'字段等值匹配负责文件路径、错误码和 ID。BM25 补充共同词语。三路融合后，注入最多 12 条并限制 token。',20,blue)
text(93,2131,'正文与向量一同保存。查询向量定位 ID，再按 ID 读取正文。一条记忆的多个片段按父 ID 去重计数。',19,gray)

section(2215,2810,'C','每条记忆自己计算半衰期',
        '强度像剩下的电量。半衰期是电量减半要多久，取决于重要性、复杂度和召回次数。',gold)
for x,title,body in [
    (sx[0],'强度 · 0–100',['刚记下或实际使用后是 100。','随时间下降，低于 20 停止召回。']),
    (sx[1],'重要性 · 1–10',['由模型按角色视角评分。','越高越耐忘，事情办完也能降分。']),
    (sx[2],'复杂度 · 1–5',['由模型按内容量和关联评分。','事实改写后重新评；越复杂越易淡。']),
    (sx[3],'召回次数 · 从 1 开始',['实际用到才加 1，次数持续累计。','同一聊天轮或任务事件只算一次。']),
]:
    card(x,2350,425,128,title,body,accent=gold,fill='#FFF8EF',edge='#EDDDC6',size=19,step=26)
box((73,2500,1894,2575),'#FFF2D9',r=13)
text(92,2512,'基数 B = min(max(I − C + N, 1), 10)',24,gold,True)
text(92,2548,'半衰期 H = B² 天，范围为 1–100 天',19,gold,True)
text(965,2517,'当前强度 = 起算强度 × 0.5 ^ (经过天数 ÷ 半衰期)',21,gold)
text(965,2549,'I 为重要性，C 为复杂度，N 为召回次数。以下例子取 I=5、C=2。',18,gray)
for i,(title,body) in enumerate([
    ('刚记下',['次数 1，周期 (5−2+1)² = 16 天','100 分，每 16 天减半']),
    ('16 天没用到',['强度减到 50 分','翻看一次，还是 50 分']),
    ('第一次真正用上',['次数 2，周期 (5−2+2)² = 25 天','回到 100 分，每 25 天减半']),
    ('频繁使用后达到上限',['次数 7 或 100，半衰期均为 100 天','每次实际使用仍恢复为 100 分']),
]):
    card(sx[i],2595,425,130,title,body,accent=gold,fill='#FFFBF4',edge='#EDDDC6',size=19,step=28)
    if i<3: arrow([(sx[i]+425,2658),(sx[i+1],2658)],gold,3)
text(73,2745,'次数继续累计，半衰期上限 100 天。实际使用恢复 100 分；单纯改分从当前强度接着算。',21,gray)
text(73,2777,'强度低于 20、事实到期或角色主动遗忘都会退出召回。待办办完立即关闭，历史经历可单独淡忘。',21,gray)

section(2835,3320,'D','聊天、任务和独立记忆线程怎么配合？',
        '同一角色的记忆队列常驻，模型线程按批次短开。评分、合并和整理随角色走，换模型可接着处理。',purple)
for x,title,body in [
    (sx[0],'聊天线程',['回复用户，提交接触过的内容','和本轮已经使用的记忆。']),
    (sx[1],'任务线程',['执行、记录进度和补查记忆，','按工作事件提交使用回执。']),
    (sx[2],'独立记忆线程',['复用角色模型和档位，按作业短开。','抽取、评分、整合与复杂语义补查。']),
    (sx[3],'SQLite + 内置编码服务',['正文和向量按角色保存，版本一起发布。','BGE-M3 全应用一个编码进程。']),
]:
    card(x,2970,425,135,title,body,accent=purple,fill='#F7F3FD',edge='#E5D9F4',size=19,step=28)
arrow([(sx[2]+425,3036),(sx[3],3036)],purple,3)
for x in sx[:2]:
    arrow([(x+196,3105),(x+196,3139),(sx[2]+196,3139),(sx[2]+196,3105)],purple,2)
label(977,3127,'送入经历或使用事件',purple)
box((73,3169,1894,3287),'#F1EEF9',r=14)
text(92,3185,'何时用生成模型',21,purple,True)
text(307,3185,'新经历与整理交给记忆线程。普通向量查询由应用直接执行，复杂意图再由记忆线程改写、筛选。',20,gray)
text(92,3220,'下一轮何时可见',21,purple,True)
text(307,3220,'同角色下一轮先等本批抽取与向量发布。失败时留作业重试，并记录索引状态。任务可继续工作。',20,gray)
text(92,3255,'线程何时换新',21,purple,True)
text(307,3255,'角色连续 4 小时没聊天，下次聊天时重建线程。重建时召回相关记忆，任务按检查点接续。',20,gray)

section(3341,3911,'E','内置 BGE-M3 ONNX INT8  [7]',
        '模型确定。角色 GPT / DeepSeek 管理记忆，内置编码器把写入正文和查询文字转换到同一语义空间。',blue)
for x,title,fill,body in [
    (72,'角色自己的模型','#F1EEFC',[
        '每个角色一个持久记忆队列。',
        '抽取、评分、合并和复杂补查按作业短开线程。',
        '龙娘复用 GPT，大肥鱼复用 DeepSeek。',
        '换聊天模型时，继续使用原来的记忆向量。',
    ]),
    (687,'内置编码进程','#EDF4FE',[
        'ONNX Runtime Node，小批量 CPU 推理。',
        '全应用共用一份 BGE-M3，首次查询按需加载。',
        '生成归一化 1024 维向量，前台查询优先。',
        '短片段编码，空闲后可退出进程释放内存。',
    ]),
    (1302,'SQLite + 检索 worker','#EAF5F1',[
        '正文、向量、来源和计分按角色保存。',
        '先筛归属和有效状态，再比较余弦相似度。',
        '融合全文和字段候选，返回带来源的记忆。',
        '一万片段的纯向量约 41 MB，元数据另计。',
    ]),
]:
    box((x,3493,x+592,3703),fill,'#DCE4F0',r=16)
    text(x+20,3510,title,24,blue,True)
    rows(x+21,3555,body,550,19,32)
arrow([(664,3593),(687,3593)],blue,3)
arrow([(1279,3593),(1302,3593)],blue,3)
text(74,3728,'下载与分发',20,blue,True)
text(245,3728,'固定版本随安装包附带。当前权重约 570 MB，连同分词器等资源约 592 MB，推理库另计。',20,gray)
text(74,3763,'选择依据',20,blue,True)
text(245,3763,'memsearch 自测中文 Recall@5 77.6%、英文 81.4%。Rainbow 的中英、跨语言和内存需单独验收。',20,gray)
text(74,3798,'本机初测',20,blue,True)
text(245,3798,'Python CPU 编码短句约 29–59 毫秒，含加载的进程峰值 1.58 GiB。Electron 内存与延迟待测。',20,gray)
text(74,3841,'参考源',20,blue,True)
text(245,3841,'huggingface.co/BAAI/bge-m3  ·  huggingface.co/gpahal/bge-m3-onnx-int8',18,blue)
text(245,3874,'github.com/zilliztech/memsearch/blob/main/docs/home/embedding-evaluation.md',18,blue)

section(3941,4361,'F','memory_search 什么时候接，谁来执行？',
        '由 Rainbow 实现 MCP 记忆服务。先启动服务，再将工具注册给角色的运行时，模型执行过程中按需调用。',purple)
for x,title,body in [
    (sx[0],'1. Rainbow 启动',['主进程启动本机 MCP 记忆服务。','服务准备好后，角色可以接入。']),
    (sx[1],'2. 启动角色运行时',['Codex app-server 写本次 MCP 配置。','DSH headless 加 MCP 客户端配置。']),
    (sx[2],'3. 模型轮次开始前',['连接初始化并读取 tools/list。','模型收到 memory_search 的定义。']),
    (sx[3],'4. 模型决定回想时',['发出 tools/call，Rainbow 绑定角色。','BGE 编码、检索、按 ID 返回正文。']),
]:
    card(x,4080,425,135,title,body,accent=purple,fill='#F7F3FD',edge='#E5D9F4',size=19,step=28)
for i in range(3):
    arrow([(sx[i]+425,4148),(sx[i+1],4148)],purple,3)
text(74,4240,'只读的含义',20,purple,True)
text(270,4240,'这个工具查询已有记忆。实际采用回执触发强化，记忆线程通过结构化提案提交写入和修订。',20,gray)
text(74,4277,'角色如何绑定',20,purple,True)
text(270,4277,'由应用绑定调用身份。模型提供问题，平台确定它能检索的范围；返回结果接回原来的线程。',20,gray)
text(74,4314,'复杂问题',20,purple,True)
text(270,4314,'可交独立记忆线程改写和筛选。记忆作业的补查直接执行底层检索，避免再次等待自己的队列。',20,gray)

box((44,4391,1926,5018),'#FFFFFF','#DCE4F0',r=24,w=2)
text(73,4423,'参考源与选择理由',34,ink,True)
text(74,4480,'每个来源对应图上同编号的节点。平方公式、复杂度等级和召回阈值由 Rainbow Mates 定义。',20,light)
for x,y,num,title,urls,reasons,accent in [
    (73,4522,'1','Meow Memory + SQLite FTS5',
     ['github.com/Phant0Meow/dsh-meow-memory  ·  sqlite.org/fts5.html'],
     ['SQLite 便于原子发布正文、向量和来源。FTS5 / BM25 作为补充，',
      '有助于找到原样错误码、路径和主题词。'],blue),
    (1000,4522,'2','MDL + CoMMA',
     ['arXiv:2609.22043  ·  aclanthology.org/2026.aacl-long.88/'],
     ['相关内容也可能过期或彼此冲突。单独核对来源和版本，',
      '避免把词面最相近的结果直接当事实。'],red),
    (73,4684,'3','Convai + Mem0',
     ['Conv-AI/Convai-Documentation  ·  mem0ai/mem0 · arXiv:2504.19413'],
     ['Convai 提供角色隔离思路。Mem0 由生成模型抽取、合并记忆，',
      '检索由 embedding 模型按意思取候选，关键词可参与排序。'],purple),
    (1000,4684,'4','Generative Agents + MemoryBank + Feiyuos',
     ['arXiv:2304.03442  ·  arXiv:2305.10250  ·  YeStarOne/feiyuos-memory-graph'],
     ['前者给出重要性 1–10 的评分思路。后两者为使用强化和指数衰退',
      '提供参考，便于算清什么时候还能想起。'],gold),
    (73,4846,'5','Letta Sleep-time Compute',
     ['letta.com/blog/sleep-time-compute/'],
     ['平时吸收新信息，空闲时才集中归纳零碎经历。这样新记忆',
      '下一轮就可用，费时的归纳可后置。'],green),
    (1000,4846,'6','LangGraph Persistence',
     ['docs.langchain.com/oss/javascript/langgraph/persistence'],
     ['任务进度确定地按任务 ID 取检查点。即使换线程或没召回相关',
      '经历，完成到哪一步仍有记录可查。'],blue),
]:
    reference(x,y,894,num,title,urls,reasons,accent)

line([(44,5063),(78,5063)],blue,3)
text(90,5054,'本轮数据或上下文流转',18,gray)
line([(351,5063),(368,5063)],purple,2)
line([(375,5063),(392,5063)],purple,2)
text(405,5054,'条件触发、后台处理或续办',18,gray)
text(1923,5054,'角色实际接触到的内容，才可能成为它的记忆。',18,gray,anchor='rt')

output=Path(__file__).resolve().with_name('rainbow-mates-memory-architecture.png')
im.save(output,optimize=True)
print(output.resolve())
