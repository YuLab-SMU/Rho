# Rho 基础修复与升级计划

Updated: 2026-11-15.

这份计划把三轮实验汇总出的 6 类 46 条现象转成可执行的修复批次。实验记录描述了实际机器上的残留、分散路径、进程和宿主注册。它们先作为基线证据保留，再由一次可重复的隔离环境复现确认哪些问题仍存在于当前主线和发布包。

## 实施状态

2026-11-15 的 F0 episode 已经把 F1–F6 的本地核心入口跑通。当前主线提供平台路径解析、安装 manifest、`paths`、`doctor`、诊断 bundle、迁移 dry-run/apply/rollback、profile 配置、start/stop/status/restart、版本盘点、upgrade、临时目录与缓存预算、日志轮转、宿主 JSON 所有权清理、service descriptor/manager registration 和事务式 npm 卸载。验收脚本在 disposable HOME 和 npm prefix 中完成了 31 个步骤，包含 `~/.rho` quick start 与 `~/Rho/projects` 静默迁移；macOS 与 Linux 容器都通过了完整 episode，独立的 platform matrix 已覆盖 macOS、Linux/XDG 和 Windows/APPDATA 的路径与 native descriptor 契约；最终 Windows CI 还实际创建并删除了 Task Scheduler 任务。逐项证据见 [implementation audit](FOUNDATION-REPAIR-AUDIT.md)。宿主连接器版本和 macOS/Linux 原生 service manager 仍需各自的机器证据。

## 目标

Rho 需要具备一套可观察、可恢复、可重复的本地安装与运行基础。

- 用户通过一个受支持的入口完成安装、启动、停止、诊断、迁移、升级和卸载。
- 每个写入位置、进程、锁、端口、缓存和宿主注册都有归属、生命周期和可枚举记录。
- 迁移和卸载以事务日志推进，重复执行得到同一个结果，失败后可以继续或回滚。
- 项目文件、项目工作状态、已确认结果、原始任务身份和未知结果都按现有语义保留。
- 原生工具继续使用其自身身份和权限。观察原生活动不会赋予托管执行保证。
- macOS、Linux 和 Windows 使用各自的数据目录约定，配置优先级和命令行为保持一致。

## 基线判读

当前主线已经包含一些局部能力。`rho --background`、`rho --status`、`rho --stop`、`rho open`、`rho remove`、`RHO_*` 的少量运行时覆盖，以及项目级 `project.doctor` 都需要继续使用。实验中出现的手工 `nohup`、多份 `cli.js`、人工拼接的清理顺序和隐藏目录仍然说明这些能力缺少统一入口、安装足迹、迁移策略和宿主清理契约。

本计划不把实验机器上的目录直接当成可删除对象。第一批工作只在 disposable HOME、disposable npm prefix、disposable project 和可控宿主配置副本中运行。任何未知归属的文件都进入报告或隔离区，等待明确归属。

## 目标目录模型

Rho 使用一个应用命名空间和五类目录。项目根目录由用户选择，服务目录由平台解析器生成。

| 类别 | macOS | Linux | Windows | 内容 |
| --- | --- | --- | --- | --- |
| 配置 | `~/Library/Application Support/Rho/config.json` | `$XDG_CONFIG_HOME/rho/config.json`，默认 `~/.config/rho/config.json` | `%APPDATA%\\Rho\\config.json` | profile、默认项目选择、非机密选项 |
| 数据与状态 | `~/Library/Application Support/Rho/` | `$XDG_STATE_HOME/rho`，默认 `~/.local/state/rho` | `%LOCALAPPDATA%\\Rho\\state` | service 状态、项目索引、principal、迁移记录、安装 manifest |
| 运行时 | `~/Library/Application Support/Rho/runtime/` | `$XDG_RUNTIME_DIR/rho`，无该变量时使用 state 下的 runtime | `%LOCALAPPDATA%\\Rho\\runtime` | PID、IPC、profile 运行记录、短期锁元数据 |
| 缓存 | `~/Library/Caches/Rho/` | `$XDG_CACHE_HOME/rho`，默认 `~/.cache/rho` | `%LOCALAPPDATA%\\Rho\\cache` | 可重建缓存、插件索引、预览和临时归档 |
| 日志 | `~/Library/Logs/Rho/` | `$XDG_STATE_HOME/rho/logs` | `%LOCALAPPDATA%\\Rho\\logs` | 结构化日志、轮转文件、崩溃摘要 |

项目内只保留项目工作状态。目标布局是 `.rho/` 下的 schema、records、buffers、layouts、agent 和 README，服务级 `connection`、principal、PID、端口、锁和日志全部由应用目录管理。现有 `.rho/rho/`、项目内 `service.lock` 和其他旧布局通过迁移处理。

项目根目录不会因为服务目录迁移而被移动。开发源码、用户项目和 Rho 运行数据在 `rho paths` 中分别列出，并显示 owner、来源和可删除条件。

## 工作包与责任

| 编号 | 工作包 | 主要责任方 | 结果 |
| --- | --- | --- | --- |
| F0 | 复现、盘点和保护 | Rho | 隔离环境、问题指纹、基线 manifest、验收脚本 |
| F1 | 路径、状态 schema 和迁移 | Rho | 平台路径解析器、版本化状态、迁移日志、回滚包 |
| F2 | 安装、卸载和版本收敛 | Rho 与 Release | 安装 manifest、单一激活版本、幂等卸载、npm 安装验收 |
| F3 | 配置、profile 和服务生命周期 | Rho | 配置优先级、start/stop/status/restart、PID 与锁治理、可选宿主服务单元 |
| F4 | 临时目录、缓存和日志 | Rho 与各插件 owner | TTL、体积预算、轮转、失败清理、配置与缓存解耦 |
| F5 | 宿主注册与对称清理 | Rho、Rho-plugins、宿主连接器 owner | install/uninstall/verify/repair 适配器、逐条所有权、Cursor worker 隔离 |
| F6 | 安全、可观测性和跨平台发布 | Rho、Rho-core、Rho-plugins、Release | `doctor`、`paths`、诊断包、密钥传递、三平台安装升级矩阵 |

Rho 负责应用选择、路径、配置、安装足迹、服务生命周期和诊断。Rho-core 继续负责托管执行、Host 和 Host 自身的停止语义。Rho-plugins 负责插件实际创建的缓存、Skills、MCP、UI 和宿主连接器条目。宿主应用保留其配置格式和权限规则。每个 owner 只清理自己写入且能证明归属的条目。

## 分阶段计划

### F0 复现和保护

先建立 `scripts/foundation-episode.mjs` 和 disposable HOME 流程，覆盖 npm 全局 prefix、源码 checkout、旧版本包、旧状态目录、项目 `.rho`、临时目录和 WorkBuddy 配置副本。

交付内容如下。

- 记录安装包、bin shim、state、project、runtime、cache、log 和宿主注册的实际路径、权限、大小、mtime、owner 和 digest。
- 给每条实验现象生成稳定的 issue key，后续验收按 key 追踪。
- 记录 `rho`、`rho-ui`、`rho-screen-check` 的真实解析路径和包版本，记录每个 profile 的命令、端口、PID、锁和日志。
- 在复现期间只处理隔离目录。真实用户 HOME 只做只读诊断。
- 形成第一份 `FOUNDATION-REPAIR-EPISODE.md`，把观察、原因、变更和再次运行结果分开记录。

退出条件是能在三种平台上重放安装失败、半卸载、旧状态迁移、崩溃恢复和宿主残留中的至少一组，且结果带有可比较的 manifest。

### F1 路径和状态迁移

实现一个唯一的 `PathResolver`，按平台返回配置、数据、state、runtime、cache、log、projects 和 install manifest。解析结果写入 `rho paths`，启动和诊断都使用同一解析器。

状态文件采用带 `schemaVersion`、`installationId`、`createdAt`、`owner` 和 `source` 的 envelope。迁移通过 journal 记录 `planned`、`copied`、`verified`、`switched` 和 `cleaned` 阶段。每个旧目录先做只读 inventory，写入新位置后逐项校验，再切换 connection 和 profile。未知文件进入带 digest 的 quarantine，迁移报告保留原路径。

迁移覆盖以下来源。

- `~/Rho/projects`、`~/Rho/state`、`~/Rho/running` 和 `~/Rho` 下的 tutorial/debug 目录。
- `~/rho-local-play`、`~/.rho-app`、`~/.rho-state` 和旧的日志、锁、临时目录。
- 项目 `.rho/rho/` 和项目内的服务级锁、连接和日志。
- `tutorial-state-*`、手工 patch 副本、旧版本日志和随机后缀的 npm staging 目录。

迁移默认保留源目录的只读备份。`rho migrate --dry-run` 只报告，`rho migrate --apply` 写入 journal，`rho migrate --rollback OPERATION_ID` 只回滚已验证的切换阶段。项目文件和项目记录的 identity、版本、来源和确认结果逐项校验。

### F2 安装、卸载和版本收敛

安装和卸载共用一份 manifest。manifest 至少包含 package name/version、npm prefix、包根、所有 bin shim、激活 profile、应用目录、项目目录、宿主适配器、运行实例、迁移 journal 和创建时间。每个条目带 owner、expected digest、删除条件和恢复位置。

CLI 形成以下稳定入口。

| 命令 | 行为 |
| --- | --- |
| `rho install` | 检查 Node、npm prefix、权限和旧版本，写入安装 manifest，创建受支持目录 |
| `rho uninstall --dry-run` | 只列出服务、bin、包、state、cache、logs 和宿主条目 |
| `rho uninstall` | 停止 Rho，完成 manifest 声明的宿主反注册和包管理器清理，写入完成 receipt |
| `rho uninstall --purge` | 在显式确认后清理 Rho-owned state、cache、logs 和 quarantine，项目目录单独选择 |
| `rho versions` | 列出 active binary、发现的副本、包版本、schema、Core、Plugins 和 adapters |
| `rho doctor --repair` | 只修复 manifest 能证明归属的 shim、残留锁、runtime note 和缓存索引 |

卸载以事务阶段推进。发现、停止、快照、宿主反注册、包管理器调用、bin reconciliation、state 清理和 receipt 各自有结果。失败后再次执行从 journal 继续。随机后缀目录只在 parent、命名模式、manifest owner、digest 和安全 TTL 同时满足时进入清理候选。用户项目、未确认结果和未知归属内容进入报告或 quarantine。

包保留三个旧命令名的兼容 shim，但它们都指向一个带版本的主 launcher。shim 的创建和删除记录在 manifest 中。新版本不再依赖手工 patch 副本，`rho versions` 对旧副本给出路径、版本、来源和推荐动作。

### F3 配置、profile 和服务生命周期

配置优先级固定为命令行显式值、`RHO_*` 环境变量、profile 文件、用户配置、平台默认值。每项配置在 `rho config schema` 中声明类型、敏感级别、来源和迁移规则。现有旗标继续兼容，并将映射写入 profile，减少启动时重复传参。

建议的公共入口如下。

- `rho start [--profile NAME]` 创建目录、加载配置、登记 PID、端口、锁、日志和 profile。
- `rho stop [--profile NAME]` 发送服务级停止请求，等待服务确认、锁释放和进程退出，重复执行得到稳定结果。
- `rho status [--profile NAME]` 显示 endpoint、PID、start time、profile、port、lock owner、log、last shutdown 和其他实例。
- `rho restart [--profile NAME]` 按 stop 后 start 的顺序运行，保留同一个 installation 和 profile identity。
- `rho profile list|create|remove` 管理多实例，profile 绑定 root、state、port、logs 和 plugins 选择。
- `rho service install|uninstall` 在用户显式选择后生成或移除 macOS LaunchAgent、Linux systemd user unit 或 Windows 任务注册。

Unix 锁使用服务进程拥有的可识别锁实现。锁记录包含 profile、installation、PID、启动时间、endpoint 和 owner。辅助锁进程不再作为无登记的长驻进程存在。Windows 继续使用平台支持的独占句柄。PID 复用、陈旧锁和无响应 endpoint 都进入 doctor 报告。

敏感值使用 `RHO_*_FILE`、受保护的环境文件或系统密钥存储。`--api-key` 进入兼容期后只给出迁移提示，诊断、status、日志和进程记录全部做值脱敏。

### F4 临时目录、缓存和日志

所有短期产物由 `TempRegistry` 创建，目录名包含 operation、profile、owner、createdAt、expiresAt 和 cleanup policy。成功、失败、取消和服务启动时都会运行有限的收尾。`rho cache list`、`rho cache prune` 和 `rho logs` 显示来源、大小、TTL、pin 和清理结果。

初始预算作为可配置 profile 选项记录。达到限制时先执行过期清理，仍超限则拒绝新建对应资源并保留现有输出和不确定性。

| 资源 | 初始限制 | 超限行为 |
| --- | --- | --- |
| 临时目录 | 10,000 项或 1 GiB | 清理已过期项，仍超限时拒绝新临时目录 |
| 可重建缓存 | 2 GiB | 按 LRU 清理未 pin 项，全部 pin 时返回 limit |
| 单个日志 | 10 MiB，保留 5 个轮转文件 | 轮转当前文件，保留崩溃摘要 |
| 日志总量 | 100 MiB，保留 30 天 | 删除过期轮转文件，当前文件继续写入 |
| doctor 扫描 | 10,000 项、4 层、30 秒 | 截断并报告 omitted 数量 |

插件创建 fake HOME 时只复制 allowlist 内容，并登记来源和过期时间。宿主 credentials、connection、principals 和 settings 快照不复制到临时区。`.skill-list-cache.json` 通过 config digest 和独立 cache schema 关联，配置删除后按 digest 失效，不依赖整份配置快照。

### F5 宿主注册与对称清理

建立 `HostAdapter` 契约，每个适配器提供 `detect`、`listOwned`、`install`、`uninstall`、`verify` 和 `repair`。每个条目至少包含 host、kind、path、key、owner、package identity、version、digest、createdAt 和 reversible 状态。

WorkBuddy 的 Skills、connector、my-experts、assistant-display、experts、local-assets、plugin-account-state、settings、expert 和 installed-store 按条目登记。卸载只删除 manifest 声明且 digest 匹配的 Rho 条目。配置与缓存耦合时，适配器执行结构化更新并重建缓存，保留宿主的其他设置。宿主不可用时写入 pending cleanup receipt，下一次 `rho doctor --repair` 继续处理。

Cursor 或其他 Agent worker 使用 runtime 下的 profile/workspace 目录。源码 checkout 只作为项目 source，不作为 worker-dir 默认值。worker 的启动、停止、父子关系和归属都登记到 process registry，清理源码仓库不会隐式停止其他工具。

### F6 安全、可观测性和跨平台发布

`rho paths`、`rho doctor`、`rho status --json`、`rho versions` 和 `rho logs --json` 共用一份诊断 schema。doctor 默认只读，`--repair` 只运行安全修复，`--scan` 才扩大到已知根目录之外，并受项数、层数和时间预算约束。

doctor 最少检查以下内容。

- active binary、npm prefix、bin shim、包版本和重复副本。
- 配置、state、runtime、cache、logs、projects 的解析结果和权限。
- profile、PID、端口、锁、endpoint、shutdown receipt 和 orphan note。
- manifest、migration journal、quarantine 和 pending cleanup。
- 临时目录、缓存、日志的数量、大小、TTL 和 owner。
- Core、Plugins、Rho-plugins adapter 的 source/artifact identity。
- WorkBuddy、Cursor 等宿主的可证明 Rho-owned 条目。

诊断结果使用 `ok`、`warn`、`fail`、`unknown` 和 `omitted`，同时返回 remediation、operation ID 和证据路径。未知状态继续保留，诊断读取不会启动服务、Agent、R 或 Host。

发布验收加入三平台的安装、升级、回滚、崩溃恢复、路径迁移、宿主清理和离线诊断。Release 记录 Rho、Rho-core、Rho-plugins、插件适配器和候选包的 immutable source/artifact identity。候选包验证与 npm 发布保持分离。

## 46 条问题的映射

| 类别 | 编号 | 工作包 | 验收重点 |
| --- | ---: | --- | --- |
| A | 1 | F2 | npm staging 冲突可诊断，清理按 manifest 和 journal 恢复 |
| A | 2 | F2/F1 | 随机残留目录有 owner、TTL、digest，失败可重试 |
| A | 3 | F2 | 三个 shim 与包状态一致，半卸载可由 doctor 修复 |
| A | 4 | F2 | 主 launcher、兼容 shim、包根在 manifest 中成组记录 |
| A | 5 | F2/F6 | `uninstall`、`doctor`、`paths`、dry-run 有稳定输出 |
| A | 6 | F2 | 卸载阶段有顺序、journal 和幂等重入 |
| A | 7 | F2/F5 | 停服、状态清理、宿主反注册都有 receipt |
| A | 8 | F2 | `rho versions` 枚举全局、checkout、app 目录和副本 |
| A | 9 | F2/F6 | 版本、schema、Core、Plugins 和 adapter identity 可追踪 |
| B | 10 | F1 | home 根目录旧布局迁移到平台目录，项目另行列出 |
| B | 11 | F1 | `rho-local-play` 被识别为项目或 quarantine，显示 owner |
| B | 12 | F1/F2 | `.rho-app` 迁移为受支持安装和数据目录 |
| B | 13 | F1 | state、config、log、lock、cache 分层 |
| B | 14 | F1 | 应用命名空间统一，路径语义由 `rho paths` 说明 |
| B | 15 | F1 | `.rho` 项目状态不再嵌套 `.rho/rho`，旧目录可回滚 |
| B | 16 | F1 | 源码仓库、项目根、运行数据分别命名和归属 |
| B | 17 | F1/F3 | service lock 与连接状态移出项目目录 |
| B | 18 | F1 | macOS、XDG、Windows 目录规则在同一解析器中实现 |
| B | 19 | F4 | 日志集中、轮转、保留策略和 owner 可查询 |
| B | 20 | F1 | 复制目录改为 schema migration，保留 identity 和结果 |
| B | 21 | F3 | 空锁有 owner、PID、profile 和恢复动作 |
| C | 22 | F1/F3 | 首次启动自动创建目录并检查归属和权限 |
| C | 23 | F3 | flags 映射为 profile 配置，重复启动复用配置 |
| C | 24 | F3 | 配置文件、`RHO_*`、优先级和 schema 可读 |
| C | 25 | F3/F4 | 日志由服务写入，shell 重定向不再是生命周期契约 |
| C | 26 | F3 | stop/status/restart、PID、可选宿主服务单元可用 |
| C | 27 | F3 | SIGTERM、Ctrl+C、`rho stop` 共享同一停止事务 |
| C | 28 | F3 | 锁由服务进程持有，辅助进程有登记和退出证据 |
| C | 29 | F3 | profile 绑定 root、state、port、log 和插件选择 |
| C | 30 | F3 | setup 文档生成声明式配置和可复制命令 |
| C | 31 | F3/F6 | 启动配置留在 profile 和 manifest，doctor 可读取来源 |
| C | 32 | F3/F6 | secret file、stdin 或 keychain 替代命令行明文 |
| D | 33 | F4 | 临时目录登记、TTL、体积限制、失败收尾和 prune |
| D | 34 | F4 | fake HOME 只含 allowlist，宿主配置不复制进临时区 |
| D | 35 | F4 | cache 以 digest 和 schema 关联，配置删除能失效引用 |
| D | 36 | F4/F5 | 宿主会话快照按 owner 和 TTL 管理 |
| D | 37 | F4 | tutorial/debug 产物进入 disposable registry，过期自动清理 |
| E | 38 | F5 | 宿主注册逐条带 owner、digest 和版本 |
| E | 39 | F5 | install/uninstall 成对实现，缺失适配器有 pending receipt |
| E | 40 | F5 | Skills、recents 等条目可逐项移除并验证 |
| E | 41 | F4/F5 | cache 更新使用结构化失效，不删除整份宿主设置 |
| E | 42 | F5 | worker-dir 默认位于 runtime，源码目录解耦 |
| F | 43 | F2/F6 | 安装 manifest 可枚举写入位置、生命周期和归属 |
| F | 44 | F6 | paths/doctor 输出路径、体积、状态和 remediation |
| F | 45 | F1/F6 | 五层写入点收敛到单一入口和 owner registry |
| F | 46 | F3/F6 | 进程、端口、锁和 fake HOME 都关联到 profile/operation |

## 交付顺序

### 批次 1 先建立证据和回滚能力

包含 F0、F1 的只读 inventory、manifest、PathResolver、schema envelope、migration dry-run、quarantine 和 `rho paths`。这批不删除旧目录，不改变托管执行语义。

### 批次 2 收敛安装和服务入口

包含 F2、F3 的 `install`、`uninstall --dry-run`、`doctor`、profile、start/stop/restart、锁 owner、PID、端口和日志绑定。先在 disposable npm prefix 运行，再覆盖当前发布包的升级路径。

### 批次 3 收敛临时资源和宿主注册

包含 F4、F5 的 TempRegistry、cache schema、日志轮转、HostAdapter、WorkBuddy 逐条清理和 worker-dir 隔离。每个 owner 提交自己的适配器检查，Rho 只负责组合和 receipt。

### 批次 4 做三平台硬化和版本发布

包含 F6 的密钥传递、诊断包、三平台安装升级回滚、崩溃恢复、权限和路径带空格验收。候选包先经过 acceptance，再按现有 release 规则发布。

### 批次 5 结束旧布局兼容窗口

旧目录在迁移报告中保留来源和 digest。兼容窗口结束前，`doctor` 继续报告未迁移项。结束条件是所有受支持升级路径都能从旧版本导入、回滚和恢复，之后才移除旧路径扫描和兼容 shim。

## 验收矩阵

每个批次至少运行一次真实 episode，观察结果后再修改 owner 代码。验收记录保存命令、实际路径、版本、digest、进程、端口、日志尾部、失败原因和修复后的第二次结果。

| 场景 | 必须观察的结果 |
| --- | --- |
| 新 prefix 安装 | 一个 active package、一个 manifest、三个兼容命令均指向同一版本 |
| 安装中断后重试 | staging 可识别、可清理、可恢复，npm prefix 没有半卸载状态 |
| `uninstall --dry-run` | 列出受影响对象和体积，不写入、不停止未知服务 |
| 完整卸载后再次运行 | 第一次完成，第二次返回稳定的已完成结果，用户项目仍可打开 |
| 旧目录迁移 | project IDs、principal IDs、已确认结果和文件 digest 保持一致 |
| 两个 profile | root、state、port、log、PID 和 lock 分离，冲突被明确报告 |
| 正常停止和崩溃 | 停止有 receipt，崩溃有 unknown/crash 证据，重启不重复执行工作 |
| 临时目录暴增 | prune 按 TTL 和预算运行，达到限制时保留输出并拒绝新的临时资源 |
| 宿主部分失败 | 已完成条目保留 receipt，未完成条目标记 pending，重复 repair 可继续 |
| 密钥传递 | `ps`、status、日志和诊断包不出现明文值 |
| 三平台发布 | macOS arm64、Linux x64/arm64、Windows x64 各有安装、升级、回滚和 stop 证据 |

## 迁移和回滚规则

- 任何写操作先生成 operation ID、输入 digest、目标路径、owner 和恢复位置。
- 目录移动优先使用同一文件系统上的原子 rename。跨设备迁移先复制、校验、写入 receipt，再切换引用。
- 迁移期间保留旧版本可读取的备份，保留期由 `migration.retentionDays` 控制，默认 30 天。
- 用户确认过的项目内容和未知结果以只读归档或 quarantine 保留。清理只作用于 manifest 证明为 Rho-owned 的对象。
- 任何达到预算的阶段都保留已有输出和不确定性，并返回 limit、operation ID 和下一步命令。
- 诊断和读取操作不启动 runtime，不恢复执行，不获取新的 Agent 或 Host 身份。

## 待实际 episode 决定的事项

以下选择在 F0 的真实运行结果出来后定稿。

- macOS LaunchAgent、Linux systemd user unit 和 Windows 任务注册的默认开关。
- Unix 原生文件锁实现和 Node 版本约束，目标是服务进程直接持有可诊断锁。
- 临时目录、缓存和日志预算在长时间 Agent episode 中的最终数值。
- 旧版本 shim 和 legacy path 扫描的结束版本。

## 当前决策

F0–F6 已对本地实现的可选项作出可复现决策：quick start 使用 `~/.rho` 作为项目根，并在无显式 root/state 时静默移动已有 `~/Rho/projects` 项目；服务单元默认只生成 descriptor，只有 `--apply` 才调用平台 manager，Unix 锁由服务进程持有 JSON owner 文件，预算使用本文件表中的初始值，配置与缓存通过 digest 关联，legacy shim 在兼容窗口内继续由 manifest 管理。CI 已加入 macOS/Linux/Windows 的 foundation 矩阵。宿主适配器不发布 WorkBuddy、Cursor 或其他宿主的版本范围，优先通过 Skills 和稳定的 agentic 接口保持兼容。
