# WorkBuddy 市场上架规范记录

> 内部工作笔记，**不发布**，也不是 Rho 的产品需求、设计值或验收标准。
> 记录时间：2026-11-09。内容是对 WorkBuddy 开放平台官方文档与本机市场缓存的只读观察，
> 按原文保留英文键名。凡未经真实提交验证的，均标注为「未验证」或「社区口径」。
> 外部平台规则会变，再次动手前按第 9 节来源重新核对。

## 0. 当前状态与决定

> 2026-11-10 更新。第 1–9 节是 2026-11-09 打包前的观察，保留原样；第 10 节的顺序已被下表的实际进展取代。

| 项 | 状态 |
| --- | --- |
| 开放平台注册 / 开发者认证 | 已完成（用户 2026-11-09 确认） |
| Connector 包 | **已生成**（提交 `ea5bc3d2`）：`connector/` 下的 `connector-meta.json`（`source` `rho-workspace`、`type` `cli`、`version` 1.0.0）、`cli.json`、`icon.svg`、内嵌 `skills/rho/`；`build.mjs` 打成 `work/workbuddy-rho/rho-workspace-1.0.0.zip`。走 CLI 方案（`npm install -g @rho-workspace/rho@latest`，状态 `rho --version`，最低 0.5.8），不带 `mcp.json`。见 [README](README.md) 与 [WorkBuddy connector 记录](../../docs/WORKBUDDY-CONNECTOR-EPISODE.md) |
| 依赖的 Rho 版本 | npm `@rho-workspace/rho@0.5.8` 已发布，2026-11-10 05:03 UTC 起 registry 可装（`latest`） |
| 提交审核 | 用户已在开放平台上传 v1.0.0 并提交；2026-11-10 已通过基础安全、内容安全、类目审核，进入质量评测（授权方式选「不需要用户授权」）。质量评测结果未知 |
| 点击发布 | **未进行**，等质量评测通过 |
| 独立 Skill zip（技能市场） | **未生成**，Skill 目前只随 Connector 包内嵌 |
| 本机已有连接 | `~/.workbuddy/mcp.json` 里两条 Rho stdio server（`rho-project`、`rho-ggtree`），为本地调试配置，**不能复制进市场包** |
| 其他通道 | 本机另有已生成的 Agent 型专家包产物，属于第三个市场通道，不在本记录范围内 |

第 7 节列出的是开放问题，不是验收标准。

## 1. 关键结论：发布没有 API

- 官方《开放平台概述》「快速开始」只列出：注册入驻 → 资质认证 → 创建业务类型 → 完善信息 → 提交平台审核 → 审核通过后发布上线 → 查看运行数据与版本维护，全程是后台动作。
- 同一页写「开放平台也将持续完善开发工具、**开放接口**和生态服务」，即开放接口属于后续计划，当前未提供。
- 官方文档的提交表述为「将连接器目录打包提交至 WorkBuddy 团队审核」「审核通过后转为待发布状态，**点击发布**后上架」；技能侧为「发布管理 → 技能 → 创建 → 上传压缩包 → 确认信息 → 提交审核」。
- 本机 `~/.workbuddy/connectors-marketplace/` 是下发的只读缓存：`.codebuddy-connector/connectors.json` 为市场索引，`connectors/<source>/` 为解包后的配置与 skills，`marketplace-meta/*.json` 记录 `etag` / `sha256` / `sourceKey`（指向官方 connector-plugins.zip）。没有写入或发布端点。
- 因此可自动化的只有**本地生成产物与自查**；审核、发布、更新仍需人工在后台完成。

## 2. 两个市场、两套提交物

| | Connector 市场 | 技能市场 |
| --- | --- | --- |
| 提交物 | Connector **目录**打包（`connector-meta.json` + `mcp.json` 或 `cli.json` + `icon.svg` + 可选 `skills/`） | 单个技能 **zip**（`{skill-name}/SKILL.md` + `references/` 等） |
| 展示入口 | 「专家·技能·连接器」→ 连接器 | 同菜单 → 技能 |
| 后台入口 | 开放平台连接器资产 / 提交审核 | 「发布管理 → 技能 → 创建」上传 zip |
| 能否携带 skills | **可以**，内嵌 `skills/{skill-name}/SKILL.md`，随连接器一起过审 | 技能本身就是提交物 |

Skills **不进** Connector 市场。Rho 的 8 个 md 有两条路：内嵌进 Connector 包（保证配套，推荐先做），或补齐字段后单独打 zip 上架技能市场（获得独立展示与单独安装）。两者可并存，但内容要同步。

## 3. 通用流程与更新规则

1. 注册并入驻 `open.workbuddy.cn`，完成开发者 / 企业 / 组织资质认证。
2. 创建对应业务类型，完善基础信息与能力配置。
3. 本地准备产物，按官方「提交检查清单」自查。
4. 后台提交审核 → 审核通过转「待发布」 → **点击发布**才上架。
5. 上线后更新：修改文件并**递增 `version`**，重新提交审核。

注意「审核通过」与「已发布」是两个状态。审核约 7 个工作日为社区实测口径，官方页面未承诺时效。社区资料还提到资产选「私有」后不能直接转公开，需重新新建公开版本——官方连接器和技能文档未写此条，提交时以页面为准，但不要默认「先私有再转公开」。

## 4. Connector 包规范（官方字段表）

### 4.1 目录结构

```
your-connector/
├── connector-meta.json
├── mcp.json 或 cli.json        # 二选一，一个 Connector 只能选一种方案
├── token-schema.json           # 仅 auth_mode: "token" 时需要
├── icon.svg / icon.png
└── skills/{skill-name}/SKILL.md   # 可选（MCP）/ 推荐（CLI）
```

命名：`source` 为英文 kebab-case 且全局唯一；MCP server key 建议与 `source` 一致；图标文件名固定 `icon` + 扩展名；多个 Skill 各占一个子目录。

### 4.2 connector-meta.json

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 显示名称（默认/中文兜底） |
| `name_zh` | 可选 | 中文显示名称，优先展示（v4.24.0） |
| `name_en` | 是 | 英文显示名称（v4.24.0） |
| `description` | 是 | 默认描述，中/英描述缺失时兜底 |
| `description_zh` / `description_en` | 是 | 中 / 英描述 |
| `source` | 是 | 全局唯一标识，kebab-case |
| `type` | 可选 | `"mcp"`（默认）/ `"cli"`；**CLI 方案必须显式写 `"cli"`** |
| `auth_mode` | 可选 | 省略（无需认证或客户端按 MCP 标准完成 OAuth）/ `"server-side"` / `"token"` |
| `version` | 建议 | 语义化版本，每次更新递增 |
| `examples_zh` / `examples_en` | 是 | 2–5 条使用示例，展示在详情页（v4.24.0） |
| `server_auth` | 条件 | 仅 `auth_mode: "server-side"` 时填写（v4.24.0） |
| `minWorkbuddyVersion` / `maxWorkbuddyVersion` | 可选 | 用到带版本标记的字段时必须声明对应最低版本 |

版本速查（取所用特性的最高值）：`mcpServers[].runtime` / `staticEnv` → **5.0.0**；`auth_mode: "token"` 全套 → 4.23.0；`cwd` / `disabledTools` → 4.22.15；`name_map` / `description_map` → 5.2.0。

### 4.3 mcp.json（Rho 相关字段）

| 字段 | 必填条件 | 说明 |
| --- | --- | --- |
| `mcpServers` | 是 | 顶层，且**仅包含一个 Server 配置** |
| `*.type` | sse / streamableHttp 必填 | `sse` / `streamableHttp` / `stdio`（stdio 可省略，由 `command` 推断） |
| `*.url` | HTTP 类必填 | 远程地址须 HTTPS |
| `*.command` / `*.args` | stdio 必填 / 可选 | 例如 `npx` 与参数数组 |
| `*.headers` | 可选 | HTTP 请求头 |
| `*.env` | 可选 | 环境变量，**支持 `${VAR_NAME}` 引用** |
| `*.timeout` / `*.cwd` / `*.disabledTools` | 可选 | 默认 30000 ms；后两者 v4.22.15 |
| `*.runtime` | 可选 | **v5.0.0**，stdio 运行时，仅 `{ "type": "node", "version"?: string }` |
| `*.npmRegistry` / `*.npmRegistries` / `*.staticEnv` / `*.staticHeaders` | 可选 | v5.0.0 |

关键限制：`${VAR}` 占位只能出现在 `url` / `headers` / `env` 三处，**`args` 不支持**。stdio 下用户填的值平铺进子进程环境变量；每个 `VAR` 必须对应 `token-schema.json` 的 `fields[].key`（区分大小写），敏感字段 `type: "password"`，并配置 `docUrl`。

### 4.4 cli.json（本次不采用）

`init.{platform}`、`unAuth.{platform}`、`status.{platform}` 必填，`auth` 可选；`statusMatch` / `statusMatchJson`、`authUrlDomain`、`runtime`、`versionCheck`、`authSuppressBrowser` 等可选。但官方检查清单要求 `auth` 在 10 秒内输出完整 `https://` URL、`status` 10 秒内无副作用返回且 exit code 0 表示已认证、`unAuth` 幂等清理远端会话——这是 OAuth 浏览器授权模型。Rho 是本地服务 + 本机文件凭据，没有 OAuth URL，套用会卡在检查清单。

### 4.5 内嵌 Skill 的 frontmatter

只需 `name`（kebab-case）与 `description`（含能力范围与触发词），`version` / `author` 可选。比独立上架技能市场的要求少得多，现有 `skills/rho/SKILL.md` 已满足内嵌要求。

### 4.6 提交检查清单（摘要）

- 通用：`connector-meta.json` 完整、`source` 唯一且 kebab-case、中英描述与示例齐全、图标清晰、**任何文件不得写入真实 Token / 密钥**、用到带版本标记的字段已声明 `minWorkbuddyVersion`。
- MCP：Server 可通过公网（或约定网络）稳定访问并实现标准 MCP 协议；`mcp.json` 正确且仅一个 Server；远程地址 HTTPS；Skill 写明工具用途、参数、授权范围、过期与常见错误；`token` 模式按 4.3 注入占位并用真实凭证验证连接。
- CLI：至少支持 macOS / Linux；`init`/`auth`/`unAuth`/`status` 各平台实测；全新环境 5 分钟内可完成 init → auth → status；重启客户端后 token 仍有效。

## 5. 技能独立上架规范

```
rho.zip
└── rho/
    ├── SKILL.md          # YAML frontmatter + Markdown 正文
    ├── references/       # @references/xxx.md 引用
    ├── scripts/          # 可选
    └── templates/        # 可选
```

技能市场 frontmatter 必填：`name`、`display_name`、`display_name_en`、`description`、`description_zh`、`description_en`、`version`、`author`；`examples_zh` / `examples_en`（展示在「试试这样用」）建议补齐，`allowed-tools` 可选。

**当前 `skills/rho/SKILL.md` 只有 `name` 与 `description`**，直接上传会解析失败；需补 6 个必填字段（`display_name`、`display_name_en`、`description_zh`、`description_en`、`version`、`author`），并把正文里的 Markdown 链接引用改成官方写法 `@references/xxx.md`。

打包前必清理：
- `references/connect.md` 的 `claude mcp add`、`references/install.md` 的 `~/.claude/skills/rho` → 改成 WorkBuddy 的路径与连接器流程；
- 不得把 `connection.json`、`agent-*.json` 的真实路径或内容写进包，也不得写死本机绝对路径；
- 保留现有 7 条全局规则（不擅自重启、凭据保护、`changeId` 幂等、不猜测路径、报告实际状态、拒绝要说出规则名），它们是审核时最有用的边界说明。

后台上传后平台自动开包解析并生成技能 ID，再确认市场展示名称、展示分类、服务类目、头像（实操截图显示 512×512、≤500KB、JPG/PNG，以页面为准），提交审核。解析失败可联系 `openworkbuddy@tencent.com`。「审核通过」仍需再执行发布动作。

## 6. Rho 侧适配判断（未实现，仅记录理由）

推荐 **MCP + Skill（stdio）**：Rho 已有 `rho --mcp <agent-connection-file>` 的现成 stdio MCP Server（工具 `rho_index` / `rho_resolve` / `rho_call` / `rho_read`）与已发布的 npm 包，官方明确支持 stdio + `runtime.type: "node"`。

**必须解决的障碍**：`--mcp` 的参数是每台机器、每个项目都不同的凭据文件路径，既不能写进 `args`（不支持 `${VAR}`），也不能写进包（检查清单禁止）。判断是发布一个薄 bridge 包，由它自己发现本机服务、复用或执行 `rho --grant`、再拉起 `rho --mcp` 并透传 stdio；`mcp.json` 只写 `npx -y <bridge>@<version>` 与 `runtime`。这与 `adapters/dsh-rho/` 已验证的「每会话起一个 `rho --mcp` 桥」模式一致。

参考形态（**未实现、未验证**，不是既定设计）：

```json
{
  "mcpServers": {
    "rho": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@rho-workspace/rho-wb-bridge@1.0.0"],
      "runtime": { "type": "node", "version": ">=22.22.0" },
      "timeout": 30000
    }
  }
}
```

`connector-meta.json` 相应判断：`type: "mcp"`、**省略 `auth_mode`**（Rho 不走云端 OAuth，授权由本机 `rho --grant` 的项目级 token 完成）、`minWorkbuddyVersion: "5.0.0"`（因为用了 `runtime`）。`runtime.version` 用简单 range 而非 Rho 的 engines `>=22.22.0 <27`，兼容性待验证。

提交说明里需要主动解释两点，避免按远程 MCP 的标准被误判：检查清单的「公网稳定可达 / SLA ≥99.9%」是针对远程 HTTP/SSE，本地 stdio 无公网端点、SLA 不适用；省略 `auth_mode` 不等于无鉴权——服务只绑 loopback，有 Host/Origin/CSP 校验与项目级 token 白名单。

## 7. 开放问题 / 待调试（不是验收标准）

- bridge 在全新环境（无已运行服务、无 grant 文件）如何发现服务与取得项目连接，失败时给什么可跟随的提示；
- stdio 透传、连接断开恢复、Rho 服务重启后的重连行为；
- `runtime.version` 的 range 写法与 `minWorkbuddyVersion: "5.0.0"` 的实际兼容范围；
- 省略 `auth_mode` 是否被审核接受，以及「公网 SLA 条款」对 stdio 的适用口径；
- `source`（如 `rho-workspace`）是否已被占用，需先在市场检索；
- 内嵌 Skill 与独立技能 zip 的内容同步机制；
- AGPL-3.0-only 与开放平台《开发者服务协议》《数据处理协议》的兼容性；
- bridge 包归属哪个仓库、`source` 由谁持有。

## 8. 治理边界

`AGENTS.md` 写明官方分发属于未来的 Rho-releases owner，且要在明确选定的 signed-release milestone 进行；`docs/RELEASE.md` 要求源码、已验收组合、二进制交付与安装各自留证，发布前核对 remote head/tree。把 Rho 资产上架公共市场实质上是一次对外分发，会牵涉第 7 节的归属与许可问题。**本记录不授权任何提交或发布动作**；第 7、8 节的问题由项目所有者决定后再进入打包环节。

## 9. 证据与来源

官方：
- <https://open.workbuddy.cn/> 、<https://open.workbuddy.cn/docs>（开放平台概述、快速开始、开放接口为后续计划）
- <https://open.workbuddy.cn/docs/connector>（Connector 包结构、字段表、检查清单、审核发布与更新、FAQ）
- <https://open.workbuddy.cn/docs/skill>（技能基础结构、frontmatter、子资源目录、解析失败联系邮箱）
- <https://www.workbuddy.cn/docs/workbuddy/Overview>（市场入口与扩展能力概述）

本机下发缓存（只读观察，2026-11-09）：
- `~/.workbuddy/connectors-marketplace/.codebuddy-connector/connectors.json`（市场索引）
- `~/.workbuddy/connectors-marketplace/connectors/dingtalk/cli.json`（CLI 方案真实样本）
- `~/.workbuddy/connectors-marketplace/connectors/cloudbase/mcp.json`（stdio + `runtime` 真实样本）
- `~/.workbuddy/connectors-marketplace/connectors/cisp-mcp/token-schema.json`（`auth_mode: "token"` 真实样本）
- `~/.workbuddy/connectors/marketplace-meta/*.json`（etag / sha256 / sourceKey）
- `~/.workbuddy/mcp.json`（本机两条 Rho 调试连接）

社区口径（非官方，需复核）：腾讯云开发者社区、CSDN、微信公众号等关于认证主体、7 个工作日审核、头像规格、私有资产不可转公开、付费与收款流程的描述。官方连接器和技能文档未写这些条款。

## 10. 后续顺序（待第 7 节跑顺后）

1. 复核第 9 节官方页面是否有变更。
2. 生成本目录的 Connector 包骨架（含 bridge、icon、内嵌 `skills/rho/`）与独立的 `rho.zip`。
3. 本地全新环境自查两条通道的检查清单。
4. 确认第 8 节的 milestone / owner / 许可后，人工在后台提交审核，通过后分别点击发布。
