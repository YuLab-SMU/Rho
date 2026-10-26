"""Build Rho's commissioning brief. Run from anywhere with Python 3."""
from pathlib import Path
from html import escape
ROOT = next(p for p in Path(__file__).resolve().parents if (p/'docs/STATUS.md').is_file() and (p/'AGENTS.md').is_file())
PAGES=[]
def p(text): return f'<p>{text}</p>'
def ul(items): return '<ul>'+''.join(f'<li>{v}</li>' for v in items)+'</ul>'
def card(title,body): return f'<article class="card"><h3>{title}</h3>{body}</article>'
def grid(*items,cols=2): return f'<div class="grid g{cols}">'+''.join(items)+'</div>'
def note(title,text): return f'<div class="note"><b>{title}</b><p>{text}</p></div>'
def table(head,rows): return '<table><thead><tr>'+''.join(f'<th>{v}</th>' for v in head)+'</tr></thead><tbody>'+''.join('<tr>'+''.join(f'<td>{v}</td>' for v in row)+'</tr>' for row in rows)+'</tbody></table>'
def btn(text): return f'<span class="btn">{text}</span>'
def frame(title,body,sub=''): return f'<div class="frame"><div class="bar"><b>{title}</b><small>{sub}</small></div>{body}</div>'
def shell(mode,body):
    modes=''.join(f'<div class="{"on" if n==mode else ""}">{n}</div>' for n in ['Overview','Studio','Graph','Agent','Files'])
    return '<div class="shell"><aside class="global"><strong>Rho</strong><div>Home</div><div class="on">Projects</div><div>Plugins</div><small>Settings</small></aside><aside class="project"><small>PROJECT</small><b>Study Alpha ⌄</b>'+modes+'<small>Project settings</small></aside><main>'+frame(mode,body,'Study Alpha · Project context')+'</main></div>'
def story(title,visual,action,response,kept):
    return f'<article class="story"><h3>{title}</h3><div class="story-visual">{visual}</div><div class="story-text"><p><b>动作</b>{action}</p><p><b>反馈</b>{response}</p><p><b>连续性</b>{kept}</p></div></article>'
def page(title,label,lead,body):
    n=len(PAGES)+1
    PAGES.append((title,f'<section class="page" id="p{n:02d}"><header><div class="eyebrow">RHO / PRODUCT DESIGN BRIEF <span>{label}</span></div><h1>{title}</h1><p class="lead">{lead}</p></header><div class="page-body">{body}</div><footer><span>2026-10-26 · v2 · 从零设计需求稿 · 示意图说明关系，不是视觉定稿</span><span>{n:02d} / 20</span></footer></section>'))

page('Rho：从零设计一套研究工作台','01 / COMMISSION','给产品设计师的需求稿。重新设计应用结构、交互语言与插件体系，不以现有页面为实施目标。',
 '<div class="cover">一个完整的应用。<br>进入项目后，拥有自己的工作世界。</div>'+
 grid(card('两层外壳',p('主应用与项目内部拥有清晰区分的导航和侧边栏。用户知道自己在哪个层级、哪个项目，以及如何返回。')),
 card('三种工作模式',p('Studio 直接操作内容；Graph 理解全景关系；Agent 动态工作面组织任务、过程、结果与介入点。')),
 card('一套插件语言',p('共享设计规范和交互习惯，保留每种插件的功能化特色。Agent 对话另有完整的专用组件设计。')),cols=3)+
 note('委托范围','上述范围来自本次用户澄清。后文将其展开为设计任务、场景和交付要求；具体布局、视觉语言、动效形式与组件细节由设计师探索。')+
 '<p class="caption">当前前端与上一版 20 页稿均不作为参考布局或验收基线。保留的是不丢工作、状态真实、可追溯等产品行为底线。</p>')

page('用户要完成的工作，决定界面如何组织','02 / USERS & JOBS','首轮面向个人研究者与和 Agent 协作的分析者。多人实时协作不作为本次设计委托的隐含前提。',
 table(['用户处境','需要完成的事','界面帮助其回答'],[
 ['跨项目工作','找到项目、恢复上次进度、知道哪些工作需要关注。','我在哪个项目？哪些状态属于哪个项目？'],
 ['直接分析与制作','编辑代码、检查数据、调整图形、组织研究笔记。','我在改什么？哪些内容相关？如何并排检查？'],
 ['理解研究过程','从一个结论追到数据、代码、运行和讨论。','它从哪里来？哪些是事实，哪些是建议？'],
 ['委托与监督 Agent','表达目标、给上下文、跟进任务、必要时介入。','它在做什么？需要我做什么？产出了什么？'],
 ['接续与判断','切换视角、离开再回来、理解结果并形成自己的判断。','刚才选择的对象、输入和工作位置还在吗？']])+
 grid(card('内容模型',p('Project 容纳研究工作；数据、代码、运行、结果、问题和笔记是可关联的对象。文件是对象的来源之一，不是全部产品信息结构。')),
 card('视图模型',p('同一个对象可以在 Studio、Graph 和 Agent 中呈现。视图切换改变看法，不创建另一份工作或另一套项目事实。')))+
 note('设计探索','设计师需要确认对象命名、信息层级和首屏主次。当前页面名称和文件目录树不构成最终信息架构。'))

page('先区分主应用，再进入一个项目','03 / TWO SHELLS','两个导航层级是明确需求。示意图展示作用范围；不规定只能使用双竖栏布局。',
 '<div class="scope-flow"><div class="app-home"><div class="scope-label">主应用 / 无活动项目</div>'+frame('Rho','<div class="home"><aside>Home<br><br><b>Projects</b><br><br>Plugins<br><br>Settings</aside><main><b>Projects</b><div>Study Alpha<small>Continue research</small></div><div>Study Beta<small>Recent project</small></div></main></div>','Application scope')+'</div><div class="transition">Enter project<br>→<small>Return to Projects</small></div><div class="project-entry"><div class="scope-label">项目内 / Study Alpha</div>'+shell('Studio','<div class="placeholder"><b>Project work</b><p>Studio · Graph · Agent</p><small>Content, selection and tasks belong to this project</small></div>')+'</div></div>'+
 grid(card('主应用侧栏',ul(['管理跨项目入口、最近工作与应用级能力。','项目卡与全局通知明确所属项目。','应用设置、插件管理与项目设置各有归属。'])),
 card('项目内侧栏',ul(['进入项目后有自己的导航、标题和工作入口。','Studio、Graph、Agent 都属于当前项目。','项目切换、退出项目、模式切换含义不同。'])))+
 note('需要设计师比较的方向','全局窄导航保留、项目导航并存；或进入项目后切换到项目外壳，保留明确返回入口。两种方案都必须让作用范围一眼可辨。'))

page('外壳需求：作用范围要在结构中成立','04 / NAVIGATION & SCOPE','通过位置、选中态与切换行为体现层级。无需在每个按钮旁重复解释作用范围。',
 table(['组件 / 范围','承担的任务','需要画出的关键转场'],[
 ['主应用导航','Home、Projects、应用级 Plugins 与 Settings；最终名称由设计师确定。','无项目 → 项目列表 → 进入项目；从项目返回。'],
 ['项目切换与标题','始终能辨认当前项目；切换时知道旧项目有哪些工作仍在进行。','Alpha → Beta → Alpha；恢复原模式与工作位置。'],
 ['项目内侧栏','概览、Studio、Graph、Agent、资源入口、项目设置。','首次进入、展开/收起、内容增加和空项目。'],
 ['模式内导航','Studio 的场景/视图；Graph 的范围；Agent 的任务/会话。','切换局部对象；不复制出第三套全局菜单。'],
 ['查找与定位','能找项目，也能找当前项目里的对象、任务与对话。','结果显示作用范围，打开后有清楚的返回路径。'],
 ['上下文与状态','选中对象、详情、后台工作和需关注事件。','按需展开；不以常驻说明挤占内容。'],
 ['插件入口','按用户任务找到功能，知道它作用于什么对象。','打开、加入工作面、不可用、移除后的既有内容。']])+
 note('设计边界','不把当前只有一个侧栏的实现当约束，也不预先锁定宽度、图标、颜色与菜单层数。用完整进入、返回和切换流程证明层级清楚。'))

page('Studio、Graph、Agent 是三种工作模式','05 / MODES','同一项目、同一批对象，三个不同的主要任务，需要各自的界面组织。',
 '<div class="mode-trio"><div><small>MAKE & INSPECT</small><h2>Studio</h2><p>直接操作内容</p><div>Code │ Data │ Figure</div></div><div><small>UNDERSTAND & CONNECT</small><h2>Graph</h2><p>理解全景关系</p><div>Question → Data → Result</div></div><div><small>DELEGATE & INTERVENE</small><h2>Agent</h2><p>组织动态工作</p><div>Goal → Work → Result</div></div></div>'+
 table(['模式','主内容 / 主动作','跨模式连接'],[
 ['Studio','编辑器、表格、图形、笔记；编辑、选择、排列、比较。','选中内容带给 Agent；查看其在 Graph 中的关系。'],
 ['Graph','对象、关系、分支、来源和路径；缩放、筛选、追溯、定位。','节点在 Studio 打开；路径或对象组带给 Agent。'],
 ['Agent 动态工作面','目标、计划摘要、实际进展、结果与介入点；委托、查看、调整。','结果回到 Studio；有依据的关系进入 Graph。'],
 ['Agent 专用对话组件','消息、上下文、输入、步骤与结果。它是交互组件，不是第四种模式。','在 Agent 中完整使用，在 Studio/Graph 中连续使用。']])+
 note('共同要求','切换模式保留项目、对象与上下文；分别恢复 Studio 布局、Graph 视角、Agent 当前任务和未发送输入。避免切换模式就像进入另一个产品。'))

page('Studio：一个可以真正工作的制作台','06 / STUDIO','提供直接操作内容的稳定空间。研究对象和插件特性决定工作方式，不由聊天气泡统领所有操作。',
 shell('Studio','<div class="studio"><div class="scene-tabs">Analysis　 Figures　 Notes　 +</div><div class="studio-panels"><div><b>analysis.R</b><pre>data &lt;- read_data(source)\nresult &lt;- analyze(data)</pre>'+btn('Run')+'</div><div><b>Data table</b><div class="rows">Sample　 Group　 Value<br>S01　　 A　　 0.42<br>S02　　 B　　 0.68</div></div><div><b>Figure</b><div class="plot">▂　▅　▃　▆　▄</div></div></div><div class="selection">Selected: S01, S02　 '+btn('Ask Agent')+btn('Show in Graph')+'</div></div>')+
 grid(card('需要设计',ul(['场景组织，视图打开、拆分、移动、关闭与布局恢复。','主焦点与选中对象清楚；其他视图可呈现相关内容。','专业工具、局部状态、保存与撤销有正确归属。','面板很窄、视图很多、长名称与大数据时如何退化。'])),
 card('需要回答',ul(['用户能否把代码、表和图作为同一次工作组织？','Agent 更新是否打断正在输入的内容？','布局控制易发现，同时不挤占插件主内容吗？','打开同一对象两次，是否仍能理解它们的关系？']))))

graph='''<svg class="graph" viewBox="0 0 920 345" role="img" aria-label="Conceptual project graph"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#8d99a3"/></marker></defs><g stroke="#8d99a3" stroke-width="1.5" fill="none" marker-end="url(#arrow)"><path d="M165 65H250"/><path d="M165 200H225V100H250"/><path d="M390 80H440V65H490"/><path d="M390 80H440V200H490"/><path d="M620 65H687"/><path d="M620 200H687"/><path d="M820 200H855V300H720"/></g><g fill="white" stroke="#c7d0d7"><rect x="25" y="37" width="140" height="56" rx="7"/><rect x="25" y="172" width="140" height="56" rx="7"/><rect x="250" y="40" width="140" height="80" rx="7"/><rect x="490" y="37" width="130" height="56" rx="7"/><rect x="490" y="172" width="130" height="56" rx="7"/><rect x="687" y="37" width="132" height="56" rx="7"/><rect x="687" y="172" width="132" height="56" rx="7"/><rect x="580" y="272" width="140" height="56" rx="7"/></g><g class="graph-label"><text x="57" y="72">Question</text><text x="77" y="207">Data</text><text x="290" y="75">Script</text><text x="267" y="102" class="sub">Cleanup rules</text><text x="533" y="72">Run A</text><text x="533" y="207">Run B</text><text x="722" y="72">Result A</text><text x="722" y="207">Result B</text><text x="630" y="307">Note</text></g><g class="edge"><text x="182" y="57">explores</text><text x="182" y="190">input</text><text x="635" y="56">output</text><text x="635" y="191">output</text><text x="735" y="288">discussed in</text></g><path d="M750 93V172" stroke="#536b86" stroke-width="2" stroke-dasharray="5 5"/><text x="768" y="137" class="edge">proposed comparison</text></svg>'''
page('Graph：看见整个项目，而不是一团节点','07 / PANORAMIC GRAPH','全景用于定位、解释和发现关系。必须能从全局概貌缩小到一条可读的证据路径。',
 frame('Project Graph',graph,'Overview　 Focus path　 Search')+
 grid(card('表达什么',ul(['数据、代码、运行、结果、问题、笔记等有意义的对象。','输入、产出、引用、派生、讨论等有类型的关系。','历史对象、当前对象与待验证建议有可辨认的状态。','已有关系与 Agent 建议明确分开；连线不能制造科学因果。'])),
 card('允许做什么',ul(['查找、按类型/任务缩小范围、折叠分组、聚焦上下游。','节点摘要与关系依据；打开 Studio 或带入 Agent。','从局部回全景，返回保留视角和选中对象。','大量节点仍可使用；提供可键盘操作的列表/大纲入口。'])))+
 note('交付重点','展示全景、局部路径、节点详情、筛选、无关系、关系不完整和大项目场景。不能只交一张网络图。图中对象与关系是需求示例。'))

page('Agent 灵动界面：从轻量入口到动态工作面','08 / DYNAMIC AGENT','界面随任务与状态有意义地变化。轻量入口与完整动态工作面如何结合，交由设计师探索。',
 '<div class="dynamic-sequence"><div><small>01 / 准备</small><b>Ask Agent</b><p>目标与上下文</p></div><span>→</span><div><small>02 / 工作</small><b>Comparing rules</b><p>实际步骤与对象</p></div><span>→</span><div><small>03 / 介入</small><b>Input needed</b><p>问题与相关选择</p></div><span>→</span><div><small>04 / 结果</small><b>Results ready</b><p>答案与检查入口</p></div></div>'+
 grid(card('轻量动态入口',p('人在 Studio 或 Graph 中工作时，用紧凑形态表达相关进展、结果和需介入事项；可展开查看，再收起回到原工作。')+ul(['状态条、状态岛、局部卡片等是待比较的方向。','明确对应哪个任务；多任务不混成一个总状态。','可静默、收起、稍后查看；重要性与打断程度匹配。'])),
 card('完整动态工作面',p('在 Agent 模式中，围绕任务组织目标、计划摘要、实际动作、可操作结果与必要输入；按任务组合表、图、表单和说明。')+ul(['不把所有内容压成聊天气泡或日志列表。','结果直接进入专业插件，也能成为后续对话上下文。','新增内容不抢焦点；显示变化有来源与时间。'])))+
 note('动效与真实状态','展开/收起和内容转换有连续性，并支持减少动态效果。只呈现实际状态与可解释的计划摘要，不制造“思考过程”、伪进度或装饰性的忙碌动画。'))

page('Agent 对话：一套专用的交互组件','09 / CONVERSATION','单独设计结构、输入和结果语法。既能承载完整对话，也能与当前研究对象紧密配合。',
 grid(frame('Research conversation','<div class="conversation"><div class="session-title">Cleanup comparison　 '+btn('History')+'</div><div class="message user-message">比较这两种清理规则，告诉我结果为什么不同。</div><div class="tokens">Data · selected rows　 │　 analysis.R · selected range</div><div class="message"><b>Comparison ready</b><p>Here is what changed and where it comes from.</p>'+btn('Open table')+btn('Open code')+btn('Show in Graph')+'<small>Steps and evidence ▸</small></div><div class="composer">Continue the conversation…<div>'+btn('Attach context')+btn('Send')+'</div></div></div>','Current project'),
 card('组件必须覆盖',ul(['会话身份、标题、历史和当前任务的关系。','用户消息、Agent 回答、工具/步骤摘要、结构化结果与错误。','多行输入、附件、精确上下文、查看/移除、发送与未确认状态。','连续输出、停止请求、已确认停止和未知结果。','引用可打开；查看历史时不被新内容强制拉走。','中文 IME、键盘、选择复制、草稿恢复与焦点。','接入方式和输入通道如实表达，不画出不能送达的发送按钮。'])))+
 note('需要交付的三种形态','完整对话工作面、与 Studio/Graph 并存的紧凑形态、从对象出发的上下文提问。三者共享同一会话与草稿语义，不各自发明一套聊天组件。'))

page('主应用组件：设计完整的产品骨架','10 / APPLICATION COMPONENTS','这些是设计系统里的应用组件，服务多个工作模式；不等同于当前代码中的组件目录。',
 table(['组件组','要解决的问题','设计稿应展示'],[
 ['应用导航与项目入口','跨项目定位、打开、最近访问、返回与应用管理。','首页/项目列表、进入与离开、空状态、搜索。'],
 ['项目外壳与侧栏','项目身份、模式切换、资源入口、项目设置。','项目完整外壳；与全局导航的关系。'],
 ['视图与布局容器','专业内容组合、焦点、拆分、切换、关闭与恢复。','单/多视图、窄面板、隐藏内容、键盘替代操作。'],
 ['对象摘要与上下文','选了什么、准备交给谁、来自哪个版本。','单/多对象、范围、旧上下文、不可用对象。'],
 ['结果与证据入口','结果可读、可操作、可追到生成过程。','表/图/代码/笔记、部分结果、比较与来源。'],
 ['Agent 动态入口与任务容器','不离开工作也能跟进；需要时展开完整任务。','紧凑、展开、多任务、介入、完成、失败、断线。'],
 ['Agent 专用对话','表达、上下文、消息与继续协作。','完整与紧凑形态、输入/流式/错误/历史/结果。'],
 ['查找、菜单、详情与反馈','发现操作，理解状态与恢复途径。','搜索范围、菜单、对象详情、局部错误、通知。']])+
 note('与专业插件的分工','外壳管理位置、范围、组合与跨模式协作；专业插件决定内容如何阅读和操作。插件不重复建设项目导航、会话系统与全局通知。'))

page('插件统一设计规范：一致性要落到交互','11 / PLUGIN DESIGN STANDARD','统一不只是一套颜色。定义可复用的视觉、行为和组合规则，并用不同插件检验。',
 table(['需要统一的部分','需求','保留给插件的空间'],[
 ['身份与外框','对象标题、类型、状态、布局菜单与焦点有一致语法。','内容标题、对象摘要与专用信息。'],
 ['动作层级','主动作、局部工具、更多操作与高影响操作有一致层级。','具体动作及其领域词汇。'],
 ['选择与上下文','选中范围、附带给 Agent 的内容可见且可检查。','行、实体、代码范围、画布区域等选择方式。'],
 ['结果与关系','可打开精确对象、查看来源、在 Graph 中定位。','领域结果格式、验证方法与解释。'],
 ['状态与恢复','加载、空、失败、部分、过期、只读、不可用有可理解的语法。','真实领域条件与对应的修复动作。'],
 ['输入与撤销','焦点、菜单、键盘、组合输入与撤销范围不相互抢占。','编辑器、网格、画布等成熟的专业习惯。'],
 ['主题与密度','颜色语义、字级、间距、图标、对比度与焦点表达可复用。','密集数据、长文本、大画布的内容密度。'],
 ['组合与尺寸','进入 Studio、从 Graph 打开、作为 Agent 结果时仍是同一种能力。','完整、紧凑、只读摘要等合理形态。']])+
 note('设计交付','组件变体、设计 tokens、用法与禁用例，至少三种内容形态的组合示例。本稿不预先指定颜色、字体、圆角或技术框架。'))

page('每个插件回答同一张需求卡','12 / REUSABLE PLUGIN BRIEF','可直接交给插件设计者的模板。规定必须说明的事情，不强迫所有插件使用同一种内部布局。',
 table(['字段','设计者需要说明','Data table 示例'],[
 ['用户目标与对象','谁使用、解决什么问题、操作什么内容。','检查数据质量，比较两个结果。'],
 ['专业特色','最值得突出的一到三个能力。','类型/缺失值、按键比较、快速筛选与选择。'],
 ['入口与形态','从哪里进入；完整、紧凑、摘要分别做什么。','Studio 主视图；Graph 打开；Agent 结果摘要。'],
 ['主内容与动作','首屏读什么、最重要的动作、进阶工具在哪里。','表与变化；筛选、比较、查看来源。'],
 ['选择与协作','选择含义；交给 Agent、Graph 和其他插件什么。','实体键、列、范围与对象版本。'],
 ['状态与连续性','显式状态；切换模式与返回保留什么。','筛选/排序/选择；部分数据和过期比较。'],
 ['编辑与恢复','是否改变原内容；保存、撤销、冲突和失败。','浏览与修改区分；可编辑表设计保存语义。'],
 ['尺寸与可访问性','窄面板、键盘、触控、长内容与大数据。','列多时可滚动；比较不依靠跨页记忆。'],
 ['交接材料','核心操作、异常、跨模式串联与待建设能力。','选择 → 精确提问 → 比较 → Graph 来源。']])+
 note('实现方的责任','设计需要当前系统尚不具备的能力时，记录为待建设能力并评估归属。不能把“现有接口没有”改写成产品不需要，也不能把设计图当成能力已实现。'))

page('插件实例：共同规范下的四种专业性','13 / FUNCTIONAL PERSONALITY','这些实例用于验证规范是否有用。名称描述功能，最终命名与内容分组可由设计师调整。',
 grid(card('Code / 代码编辑','<div class="signature">精确编辑 · 对比修改 · 执行联系</div>'+ul(['代码、范围选择、诊断和修改差异是主内容。','解释、重构、执行代码与查看输出有清楚关系。','共享编辑、自己的撤销、保存冲突与运行快照不混同。'])+p('<b>需要画：</b>人与 Agent 的修改对比；执行后定位相关结果。')),
 card('Data / 数据表','<div class="signature">结构与质量 · 实体选择 · 比较</div>'+ul(['列类型、缺失值、单位、过滤与排序帮助理解数据。','实体对齐比较，显示前后值、差值与未匹配项。','浏览状态与修改区分；大数据保持范围感。'])+p('<b>需要画：</b>选择一组实体提问；比较结果与窄面板。')),
 card('Figure / 图形工作台','<div class="signature">画布 · 映射与选择 · 图形输出</div>'+ul(['画布占主导；图例、映射与工具按任务出现。','数据图点选与原始图像区域选择语义不同。','数据选择可与表联动；静态图框选不推断数据实体。'])+p('<b>需要画：</b>点选回表；图像区域提问；导出与来源。')),
 card('Notes / 研究笔记','<div class="signature">连续写作 · 证据引用 · 研究判断</div>'+ul(['组织问题、方法、发现和待验证判断，支持长文。','引用表、图、运行与对话，回到具体对象。','人的文字和 Agent 建议可辨认，编辑/撤销/保存连贯。'])+p('<b>需要画：</b>引用结果进笔记，再从 Graph 找回讨论。')))+
 '<p class="caption">后续可用领域插件检验专业参数、质量检查与结果视图是否也能纳入规范；不把某个科学方法写死在主应用里。</p>')

page('同一外框，三种不同的内容组织','14 / PLUGIN COMPOSITION','统一后仍要像专业工具；不同工具放进同一工作台，又能自然协作。',
 grid(frame('Code','<div class="tools">Edit　 Find　 Compare　 Run</div><div class="code-wire"><span>01　 data &lt;- read_data()</span><span>02　 clean &lt;- prepare(data)</span><span class="picked">03　 result &lt;- analyze(clean)</span><span>04　 write_result(result)</span></div><div class="context">Selected range　 '+btn('Ask Agent')+'</div>','Layout ···'),
 frame('Data','<div class="tools">Filter　 Columns　 Compare</div><div class="data-wire"><div>Entity　 Before　 After</div><div class="picked">A　　　0.42　　0.58</div><div>B　　　0.68　　0.68</div><div>C　　　NA　　 0.31</div></div><div class="context">Entity A　 '+btn('Ask Agent')+'</div>','Layout ···'),
 frame('Figure','<div class="tools">Select　 Map fields　 Export</div><div class="figure-wire"><svg viewBox="0 0 300 175"><path d="M20 15V150H280" stroke="#b9c4cd" fill="none"/><g fill="#8d9eac"><circle cx="65" cy="110" r="5"/><circle cx="102" cy="80" r="5"/><circle cx="145" cy="98" r="5"/><circle cx="205" cy="43" r="5"/><circle cx="242" cy="62" r="5"/></g><circle cx="65" cy="110" r="12" stroke="#344f69" fill="none"/></svg></div><div class="context">Entity A　 '+btn('Show in table')+'</div>','Layout ···'),cols=3)+
 grid(card('共享的部分',ul(['标题和布局入口；动作分组与焦点语法。','上下文和范围；结果、来源与 Graph 的连接。','加载/失败/部分结果、主题与可访问性。'])),
 card('应该不同的部分',ul(['编辑器保护输入；表格保护列与比较关系。','图形保护画布与选择；笔记保护阅读与写作。','每种插件采用其专业任务需要的局部控件。'])))+
 note('规范的边界','不能把所有插件包装成相同的表单、聊天卡片或通用信息面板。统一规范减少学习成本，保留专业功能。示意数据不代表研究结论。'))

page('分镜 A：进入项目，完成一次研究协作','15 / END-TO-END SCENARIO','场景：比较两种数据清理规则。从完整应用层级开始，而不是从一张已打开的表格开始。',
 '<div class="story-grid six">'+
 story('01 / 主应用选择项目','<b>Projects</b><div class="mini-project">Study Alpha　'+btn('Open')+'</div>','从主应用进入 Study Alpha。','进入该项目外壳与独立侧栏。','全局返回入口仍清楚。')+
 story('02 / Studio 直接检查','<b>Studio</b><div class="mini-panels"><span>Code</span><span class="picked">Selected data</span><span>Figure</span></div>','打开数据与代码，选择记录。','专业视图并存，范围可辨认。','布局与未保存内容保留。')+
 story('03 / 专用对话表达目标','<div class="mini-message">比较两种清理规则，解释差异。</div><small>Context: selected data + code</small>','检查附件，向选定 Agent 发任务。','目标、对象与消息连接到任务。','输入与发送状态可恢复。')+
 story('04 / 动态工作面跟进','<b>Comparing rules</b><div class="mini-steps">Read input → Run → Prepare results</div>','需要时展开 Agent，其余继续工作。','呈现进展和相关结果。','更新不抢占 Studio 焦点。')+
 story('05 / Studio 验证结果','<b>Comparison result</b><div class="mini-panels"><span>Before → After</span><span>Open code</span></div>','检查变化，核对代码与图。','比较对齐同一对象，来源可到达。','原结果仍可回看。')+
 story('06 / Graph 与笔记收束','<b>Graph</b><div class="mini-steps">Data → Run → Result → Note</div>','追溯工作，把判断写进笔记。','关系说明来源，笔记承载人的结论。','返回 Studio 保留工作位置。')+'</div>')

page('分镜 B：从全景关系进入一个具体问题','16 / GRAPH-LED SCENARIO','场景：几周后回到项目，研究者想知道一个图形为何产生，哪些工作受输入变化影响。',
 '<div class="story-grid four">'+
 story('01 / 全景定位','<b>Project Graph</b><div class="mini-steps">Questions　 Data　 Runs　 Results　 Notes</div>','查找图形，缩小到相关分支。','全局概貌变为有类型、可读的局部关系。','保留返回全景的位置。')+
 story('02 / 沿证据路径追溯','<b>Figure → Result → Run → Script → Data</b><small>Open relation evidence</small>','查看输入、脚本与运行的关联依据。','事实与建议、当前与历史对象可区分。','不把连线当成科学因果。')+
 story('03 / 带路径给 Agent','<div class="mini-message">如果替换这份输入，哪些结果需要重新检查？</div><small>Context: selected path</small>','将准确路径和对象带入对话。','动态工作面呈现分析与建议范围。','图的视角和对话上下文可返回。')+
 story('04 / 在 Studio 检查建议','<div class="mini-panels"><span>Original figure</span><span>Candidate result</span></div>'+btn('Return to Graph'),'检查候选结果，再记录判断。','结果与建议有来源；Graph 不伪造事实。','旧结果、路径和笔记可访问。')+'</div>'+
 note('要讲清楚的动作链','从哪里进入 Graph、怎样聚焦、看什么详情、如何带走上下文、做完怎样返回。它是可行动的项目视角，不能只是 Studio 的背景皮肤。'))

page('分镜 C：Agent 工作，用户继续自己的事','17 / DYNAMIC & RECOVERY','场景：长任务在进行中，用户切换对象或项目。灵动入口提供适度的连续感与介入机会。',
 '<div class="story-grid four">'+
 story('01 / 收起后继续工作','<b>Studio / editing notes</b><div class="dynamic-pill">Agent · Comparing rules · Running</div>','收起完整工作面，继续写作。','紧凑入口只显示必要状态，可按需展开。','笔记、光标与草稿不改变。')+
 story('02 / 需要人介入','<div class="dynamic-pill attention">Input needed · Choose scope</div>'+btn('Review'),'打开与任务相关的问题。','给出已有上下文与明确选择。','已有授权不因界面切换再请求一遍。')+
 story('03 / 连接或确认丢失','<b>Connection lost</b><small>Showing received work</small>'+btn('Reconnect'),'断线后读已收到的内容，再重连。','未知、失败、停止请求和已停止分开。','观察原任务，不重复发起工作。')+
 story('04 / 结果与返回','<b>Results ready</b><div class="mini-panels"><span>Open result</span><span>Later</span><span>Conversation</span></div>','现在检查结果，或稍后再处理。','通知连接同一任务、对话与相关对象。','回到原编辑位置继续工作。')+'</div>'+
 note('多任务与跨项目','紧凑入口标明对象范围；跨项目通知先说明项目，再进入对应上下文。停止只针对明确选中的任务；关闭入口、关闭视图和停止执行不混同。'))

page('异常、输入和尺寸变化，属于同一套体验','18 / STATES & ADAPTATION','在设计稿和可点击原型中展示，不留到开发时临时补一句错误提示。',
 table(['场景','设计需要表达','可继续的动作'],[
 ['首次使用 / 空项目','主应用与项目层级仍然成立，知道从何开始。','打开/创建项目，添加内容，进入 Studio 或发起任务。'],
 ['Graph 很空或很大','无关系、关系尚不完整、只显示局部是不同情况。','查找、筛选、聚焦、回全景，使用替代列表。'],
 ['Agent 等待 / 无回答','未发送、发送未确认、等待、无可靠终态分别表达。','保留输入与已收到内容，检查原任务。'],
 ['冲突 / 部分结果 / 不可用','影响范围与已保留内容清楚，不封锁整个项目。','比较修改、看已有输出、回来源、选可用入口。'],
 ['空间变窄 / 内容变长','导航层级、主对象与返回路径仍可辨认。','收起次要面板，专注视图；前后值不分开记忆。'],
 ['键盘 / 中文输入 / 减少动态效果','焦点明确，输入组合完整，状态不只靠颜色或动画。','菜单替代拖动、图对象列表、可控通知与动效。']])+
 grid(card('尺寸交付',p('桌面研究工作为主要对象，同时覆盖紧凑窗口与单个窄插件面板。手机阅读和轻量反馈采用简化方案，不机械缩小桌面截图。')),
 card('文案原则',p('产品界面使用 English；研究内容保留原始 Unicode。让结构解释作用范围，文案用于具体动作、必要状态和恢复，不堆重复副标题。'))))

page('设计师的工作包：先探索，再形成系统','19 / DESIGNER DELIVERABLES','委托的是产品设计。设计师对信息架构和交互负责，不是照着当前截图换皮。',
 table(['阶段','必须交付','评审关注'],[
 ['A / 结构探索','用户任务、产品对象、两层架构；至少两种有实质差别的外壳和灵动界面方向。','层级和模式是否清楚，方案取舍理由是否成立。'],
 ['B / 核心流程','进入项目；Studio、Graph、Agent 各自的关键帧；三条端到端可点击流程。','能否带着上下文往返，失败后能否继续。'],
 ['C / 组件与插件系统','主应用组件、专用对话、动态 Agent、插件通用规范和四个功能化实例。','统一是否减少学习成本，专业能力是否保留。'],
 ['D / 细化交接','选定方向的视觉稿、组件变体、tokens、动效/减少动态效果、尺寸、状态与行为标注。','开发是否知道动作效果、状态来源和需保留的内容。'],
 ['E / 验证与修订','观察未参与设计的人做代表性任务；记录卡点，交付修订、决策和待建设能力清单。','以人的理解和完成情况反馈，不以像不像当前界面判断。']])+
 grid(card('本轮核心范围',p('主应用与项目侧栏、三种工作模式、灵动 Agent、专用对话、插件规范、实例插件与跨模式分镜必须齐全。')),
 card('交给设计师决策',p('导航布局、Graph 的组织和缩放方式、灵动入口形态、对话嵌入方式、视觉语言与命名。用方案和场景解释选择。'))))

page('评审需求与设计成果，看这些问题','20 / REVIEW & BOUNDARIES','目标来自未来产品需要。实施团队再为选定体验建设能力；当前实现不决定应当设计什么。',
 grid(card('必须能够清楚演示',ul(['区分主应用和项目内部；进入、返回、切换项目清楚。','Studio、Graph、Agent 各有主要任务与界面组织。','Graph 能追溯和行动；Agent 随状态变化并允许恰当介入。','对话是完整组件，输入、上下文、步骤与结果连续。','插件既有统一规范，又保留代码、表、图、笔记的专业差异。','跨模式、离开返回、异常恢复，保留人的输入和已获得工作。'])),
 card('产品行为底线',ul(['对象有各自身份、版本与来源；没有代表全项目科学正确的“版本”。','同一文档多视图共享内容，保存、撤销与冲突可理解。','任务、消息、重连保持原身份；未确认结果不伪装成功或自动重做。','已有授权按实际范围执行；模型和界面建议不能扩张权限。','执行结束、产物完整、领域检查与 Agent 解释分别有依据。','动态界面组织真实能力与内容，不把视觉效果当执行或授权。'])))+
 note('文档地位与修订','v2 按用户澄清重写为从零设计需求稿，取代上一版基于现状的设计提案。功能展开用于设计委托讨论；示意框图不是视觉定稿，也不要求沿用任何当前 SDK、菜单或布局。')+
 '<div class="closing">设计师交出体验与设计系统。实施方识别能力缺口、实现并验证。共同对最终产品负责。</div>')

assert len(PAGES)==20
CSS='''
:root{--ink:#24323e;--muted:#63717c;--line:#d7dfe5;--accent:#3c5871;--soft:#eef2f5;--paper:#fbfcfd}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#e0e6eb;color:var(--ink);font:18px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}h1,h2,h3,p{margin:0}h1,h2,h3{font-weight:650;line-height:1.32}h1{font-size:39px;letter-spacing:-1px;margin:12px 0}h2{font-size:27px}h3{font-size:21px;margin-bottom:14px}p{margin-bottom:12px}p:last-child{margin-bottom:0}b,strong{font-weight:650}small{display:block;font-size:13px;line-height:1.5;color:var(--muted)}ul{margin:0;padding-left:22px}li{padding-left:3px;margin-bottom:10px}li:last-child{margin-bottom:0}pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}a{color:var(--accent)}
.page{width:1440px;height:1000px;padding:42px 54px 40px;margin:28px auto;background:var(--paper);position:relative;overflow:hidden;break-after:page;box-shadow:0 6px 30px #1f344b15}.eyebrow{font-size:12px;font-weight:650;letter-spacing:1.8px;display:flex;justify-content:space-between;color:var(--accent)}.eyebrow span{font-weight:450;color:var(--muted)}.lead{font-size:19px;color:var(--muted);max-width:1280px}.page-body{margin-top:27px}.page footer{position:absolute;left:54px;right:54px;bottom:25px;padding-top:14px;border-top:1px solid var(--line);display:flex;justify-content:space-between;color:var(--muted);font-size:12px}.caption{font-size:14px;color:var(--muted);margin-top:18px;line-height:1.6}.grid{display:grid;gap:24px;margin-top:23px}.page-body>.grid:first-child{margin-top:0}.grid.g2{grid-template-columns:1fr 1fr}.grid.g3{grid-template-columns:repeat(3,1fr)}.card{padding:23px 25px;background:#fff;border:1px solid var(--line);border-radius:10px;font-size:17px;line-height:1.65}.note{background:var(--soft);border-left:3px solid var(--accent);padding:19px 24px;margin-top:23px;font-size:17px;line-height:1.6}.note b{display:block;margin-bottom:7px}.note p{margin:0}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:16px;background:#fff;line-height:1.55}th{text-align:left;background:#eaf0f4;font-weight:650}th,td{padding:14px 17px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}th:first-child,td:first-child{width:23%}td:first-child{font-weight:600}tr:last-child td{border:0}.cover{font-size:48px;line-height:1.45;letter-spacing:-1px;font-weight:550;padding:35px 0 40px;max-width:1100px}.cover+.grid{margin-top:0}.cover+.grid .card{min-height:215px}.btn{display:inline-flex;align-items:center;justify-content:center;padding:6px 10px;background:#fff;border:1px solid #bbc9d4;border-radius:5px;color:#324e66;font-size:12px;line-height:1.4;white-space:nowrap;margin-right:4px}.bar{display:flex;justify-content:space-between;align-items:center;gap:15px;border-bottom:1px solid var(--line);min-height:50px;padding:12px 17px;font-size:14px;background:#f7f9fb}.bar>small{font-size:11px;color:var(--muted)}.frame{border:1px solid #c9d4dd;border-radius:8px;background:#fff;overflow:hidden}.scope-flow{display:flex;gap:20px;align-items:center}.app-home{width:375px;flex-shrink:0}.project-entry{flex:1;min-width:0}.scope-label{font-size:14px;font-weight:650;color:var(--accent);margin-bottom:12px}.transition{width:105px;flex-shrink:0;text-align:center;font-size:14px;color:var(--muted);line-height:2}.transition small{font-size:10px}.home{display:flex;font-size:13px;min-height:245px}.home>aside{width:95px;padding:20px 15px;background:#f0f3f6;border-right:1px solid var(--line)}.home main{flex:1;padding:20px}.home main>div{padding:12px;border:1px solid var(--line);border-radius:6px;font-size:13px;margin-top:12px}.home small{font-size:10px;margin-top:5px}.shell{display:flex;background:#fff;border:1px solid #becbd5;border-radius:9px;overflow:hidden;height:350px;font-size:13px}.global{width:95px;flex-shrink:0;border-right:1px solid var(--line);background:#e9eff4;position:relative;padding:18px 10px}.global strong{display:block;font-size:19px;margin-bottom:23px}.global>div,.project>div{padding:8px 7px;margin-bottom:4px}.on{background:#d9e4ed;color:#233f58;font-weight:600;border-radius:4px}.project{width:160px;flex-shrink:0;background:#f5f7f9;border-right:1px solid var(--line);padding:18px 12px;position:relative}.project>small:first-child{font-size:9px;letter-spacing:1px;margin-bottom:5px}.project>b{display:block;font-size:14px;margin-bottom:20px}.global>small:last-child,.project>small:last-child{position:absolute;bottom:15px;left:15px;right:10px;font-size:11px}.shell>main{flex:1;min-width:0}.shell>main>.frame{border:0;border-radius:0;min-height:100%}.project-entry .shell{height:297px}.project-entry .global{width:68px;padding:13px 6px;font-size:10px}.project-entry .global strong{font-size:15px;margin-bottom:13px}.project-entry .project{width:125px;padding:13px 9px;font-size:11px}.project-entry .project>b{font-size:11px;margin-bottom:10px}.project-entry .global>div,.project-entry .project>div{padding:6px 4px}.project-entry .global>small:last-child,.project-entry .project>small:last-child{font-size:9px;left:9px}.project-entry .bar{padding:12px;font-size:12px}.project-entry .bar>small{display:none}.placeholder{padding:45px 24px;color:var(--muted);font-size:13px}.placeholder>b{font-size:22px;color:var(--ink)}.placeholder p{margin-top:15px}.placeholder small{font-size:11px}.mode-trio{display:grid;grid-template-columns:repeat(3,1fr);gap:25px;margin-bottom:24px}.mode-trio>div{padding:22px 25px;border:1px solid var(--line);background:#fff;border-radius:8px}.mode-trio small{font-size:10px;letter-spacing:1.6px;margin-bottom:10px}.mode-trio h2{margin-bottom:4px}.mode-trio p{font-size:17px;color:var(--muted)}.mode-trio>div>div{background:#f0f4f7;padding:17px;border-radius:5px;font-size:14px}.studio{padding:18px}.scene-tabs{font-size:12px;border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:15px}.studio-panels{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:12px}.studio-panels>div{border:1px solid var(--line);border-radius:6px;padding:14px;font-size:13px;min-height:172px}.studio-panels pre{font-size:11px;line-height:2;margin:14px 0}.rows{font:12px/2.5 ui-monospace,SFMono-Regular,monospace;margin-top:10px}.plot{font-size:40px;text-align:center;color:#8094a5;line-height:2.4}.selection{font-size:11px;margin-top:15px;color:var(--muted)}.graph{width:100%;height:270px;display:block;padding:12px}.graph-label{font:15px -apple-system,BlinkMacSystemFont,sans-serif;fill:#354957}.graph-label .sub{font-size:12px;fill:#728290}.edge{font:10px -apple-system,BlinkMacSystemFont,sans-serif;fill:#71818d}.dynamic-sequence{display:flex;align-items:center;gap:20px;margin-bottom:28px}.dynamic-sequence>div{flex:1;padding:21px;border:1px solid #c9d4dd;border-radius:12px;background:#fff;min-height:155px}.dynamic-sequence>span{color:#90a1af}.dynamic-sequence small{font-size:11px;margin-bottom:12px}.dynamic-sequence b{display:block;font-size:20px;margin-bottom:10px}.dynamic-sequence p{font-size:15px;color:var(--muted)}.conversation{padding:20px}.session-title{font-size:13px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center}.message{border-top:1px solid var(--line);padding:20px 5px;font-size:14px;line-height:1.75}.message>b{font-size:19px}.message p{margin-top:8px}.message small{margin-top:16px;font-size:11px}.user-message{background:#eef3f6;border:0;padding:14px;border-radius:6px;font-size:15px;margin-bottom:14px}.tokens{font-size:11px;background:#eef3f6;border:1px solid #c3d0da;padding:10px;margin:14px 0;border-radius:4px}.composer{border:1px solid #aebfcd;border-radius:7px;padding:15px;font-size:13px;color:var(--muted);min-height:110px}.composer>div{display:flex;justify-content:space-between;margin-top:25px}.signature{font-size:15px;color:var(--accent);margin-bottom:14px}.tools{padding:15px;font-size:12px;border-bottom:1px solid #e7ecf0}.code-wire{padding:24px 10px 30px;font:11px/2.7 ui-monospace,SFMono-Regular,monospace;min-height:215px}.code-wire span{display:block;padding:0 5px;white-space:nowrap}.picked{background:#e1ebf3;color:#294a66}.data-wire{font:13px/2.5 ui-monospace,SFMono-Regular,monospace;padding:20px 16px;min-height:215px}.data-wire>div{padding:3px 7px}.data-wire>div:first-child{color:var(--muted);border-bottom:1px solid var(--line)}.figure-wire{height:215px;padding:15px}.figure-wire svg{width:100%;height:100%}.context{padding:12px 15px;background:#f4f7f9;font-size:11px;display:flex;align-items:center;justify-content:space-between}.story-grid{display:grid;gap:24px}.story-grid.six{grid-template-columns:repeat(3,1fr)}.story-grid.four{grid-template-columns:repeat(2,1fr)}.story{background:#fff;border:1px solid var(--line);border-radius:9px;overflow:hidden}.story h3{font-size:17px;padding:16px 19px;margin:0;border-bottom:1px solid var(--line)}.story-visual{background:#f0f4f7;padding:17px 19px;height:120px;font-size:13px;display:flex;flex-direction:column;justify-content:center;gap:9px}.story-visual>b{font-size:14px}.story-visual small{font-size:11px}.story-text{font-size:14px;padding:15px 19px;line-height:1.6}.story-text p{margin-bottom:7px}.story-text b{margin-right:10px;font-weight:600;color:#49647b}.story-text p:last-child{margin-bottom:0}.mini-project{background:#fff;border:1px solid var(--line);border-radius:5px;padding:9px;display:flex;justify-content:space-between;align-items:center}.mini-panels{display:flex;gap:8px}.mini-panels>span{flex:1;border:1px solid #c9d5df;background:#fff;border-radius:4px;padding:10px;font-size:11px}.mini-panels>span.picked{background:#e1ebf3}.mini-message{padding:11px;border:1px solid #c6d3dd;border-radius:6px;background:#fff;font-size:12px}.mini-steps{font-size:12px;line-height:1.8;padding:9px;border:1px solid #d9e1e8;background:#fff;border-radius:5px}.four .story-visual{height:138px}.four .story-text{font-size:15px;min-height:143px}.dynamic-pill{font-size:12px;background:#dfe9f2;border-radius:24px;padding:10px 15px;width:max-content;max-width:100%}.dynamic-pill.attention{background:#f6eddc;color:#725625}.closing{font-size:19px;line-height:1.7;padding:22px 0 0;font-weight:550;color:var(--accent)}.navigator{position:fixed;top:12px;right:15px;z-index:20;display:flex;align-items:center;gap:10px;padding:9px 12px;background:#304b62f5;color:#fff;border-radius:8px;font-size:12px}.navigator select{background:#fff;border:1px solid #879dae;border-radius:4px;padding:5px;max-width:230px;color:#304b62}.navigator a{color:#fff;text-decoration:none}:focus-visible{outline:3px solid #547b9c;outline-offset:3px}
#p04 td,#p04 th,#p10 td,#p10 th,#p11 td,#p11 th,#p12 td,#p12 th{padding:12px 16px}#p06 .shell{height:386px}#p06 .plot{font-size:29px;line-height:3.4;white-space:nowrap}#p09 .card{font-size:16px}#p09 .card li{margin-bottom:12px}#p13 .grid{gap:20px}#p13 .card{padding:22px;font-size:16px}#p13 .card p{font-size:15px;margin-top:15px}.four .story-visual{height:110px;padding:10px 19px;gap:7px}.four .story-text{min-height:120px}#p20 .card{font-size:16px}#p20 .card li{margin-bottom:12px}
@media print{@page{size:1440px 1000px;margin:0}body{background:white}.page{margin:0;box-shadow:none}.navigator{display:none}html{scroll-behavior:auto}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}@media screen and (max-width:1460px){.page{margin:20px}.navigator{position:sticky;top:8px;width:max-content;margin:10px 20px}}
'''
options=''.join(f'<option value="p{i:02d}">{i:02d} · {escape(t)}</option>' for i,(t,_) in enumerate(PAGES,1))
document=f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rho · 从零设计需求稿 · v2</title><style>{CSS}</style></head><body><nav class="navigator" aria-label="需求稿导航"><label for="page-select">从零设计需求稿 v2</label><select id="page-select">{options}</select><a href="#p03">两层外壳</a><a href="#p15">分镜</a></nav>{''.join(s for _,s in PAGES)}<script>const selector=document.getElementById('page-select');selector.addEventListener('change',()=>{{location.hash=selector.value;}});window.addEventListener('hashchange',()=>{{const id=location.hash.slice(1);if(document.getElementById(id))selector.value=id;}});</script></body></html>'''
(ROOT/'docs/design/2026-10-26/index.html').write_text(document)
print(f'Built {len(PAGES)} pages / {len(document.encode())} bytes')
