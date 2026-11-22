# AGENTS.md — dsh-workbuddy-helper 开发与运维手册

给在本仓库工作的 AI Agent 与人看的操作手册。改代码前先读完「陷阱清单」，那里的每一条都是踩过的坑。

## 1. 这个插件是什么

`dsh-workbuddy-helper` 是 DSH（DeepSeek Harness）的一个插件，把 **WorkBuddy 的三个市场**接进 DSH 会话：

| 市场 | 入口 | 效果 |
|---|---|---|
| 专家 | `workbuddy_helper { action: 'expert', expertId }` / 会话辅助面板「专家」页 | 把专家包的 `AGENTS` 正文注入当前会话的 system prompt，并把专家自带技能并入技能目录 |
| 技能 | 「技能」页 → 真实安装；`workbuddy_helper { action: 'skills', skillAction: 'install', skillId }` | 从 WorkBuddy 技能市场下载 zip，解到 `<projectRoot>/.dsh/skills/<slug>/`，下一轮即可见 |
| 连接器 | 「连接器」页；`workbuddy_helper { action: 'connector', connectorAction: ... }` | 134 条 MCP 连接器目录 → 连接 → 工具以 `mcp__<server>__*` 进入会话，并按会话启用/停用 |

核心约束：**所有选择都是会话级的**。插件不写全局配置、不替别的会话做决定；唯一会落盘到 profile 的是连接器要用的 `cordis.patch.yml`（MCP server 声明）。

## 2. 目录与职责

```
lib/index.js         插件入口：export name/inject/apply，注册工具 workbuddy_helper、命令、
                     会话钩子，构造各子系统。connectors.init() 必须调用，否则会话门控不注册。
lib/connectors.js    连接器注册表 + 连接动作 + 会话级工具门控（WorkBuddy 语义那一版）。
lib/connector-flow.js 连接流程纯函数：单飞 registry、结果归一、错误分类、凭据表单、OAuth 交接。
lib/mcp-patch.js     cordis.patch.yml 的 MCP 条目读写（vendored dsh-armory 约定，带注释保留）。
lib/skill-install.js 技能真实安装：目录查询 → 签名 URL → zip 校验 → 原子落盘到 .dsh/skills。
lib/mnemon.js       探测本 profile 有没有装 dsh-mnemon（决定「记忆系统技能市场」页签是否出现）。
lib/portal.js        WorkBuddy portal 客户端（市场/技能/连接器目录接口）。
lib/market.js        专家市场（COS 快照 + 实时接口）。
lib/session.js       会话选择状态（专家、技能开关）与 prompt 注入。
lib/webui.js         面板 HTTP 路由（状态、目录、动作、技能安装）。
lib/client.js        浏览器端 UI（React，无构建，通过宿主注入的 h/React）。
lib/auth.js          凭据解析、URL 白名单、错误类型。
lib/bundle.js        专家包下载与解包。
lib/util.js          dshHome、expandHome 等小工具。
test/*.test.mjs      node:test 单测，全部用假 portal / 假 fetch / 临时目录。
docs/                设计、逆向、端到端与连接器改造报告。
scripts/release.mjs  版本 bump → 测试 → commit → push 一条龙。
```

## 3. 连接器模型（改这里之前必须理解）

三个概念，别混：

- **config**（静态）：来自 `$DSH_HOME/storages/mcp_connector.json` 的 `tables.catalog.remote.connectors`（134 条），或本 profile 已装的连接器插件。字段 `id/name/auth/servers`。
- **state**（运行时）：`{configId, source, bound, enabled, connected, connecting, pending, reason, toolCount, tools, authMode, credentialReady, external?}`。**UI 只读 state**。
  - `connected` 的唯一判据是「宿主当前真的注册了这些工具」，不是「我们写过配置」。工具枚举走 `tools.schemas()`（**没有** `definitions()`，见陷阱 1）。
  - `reason.code` ∈ `disabled | session-disabled | no-tools | unbound | restart-required | authorize | error`。
- **action**：`connect | repairConnect | reauthorize | disconnect | unbind | cancelConnect | updateHeaders | updateEnv`，同一 id 单飞（`operations.claim`，opId = `id#seq`，过期请求 `cancelled`）。

三条落地路径：

1. **目录连接器**（catalog）：连接时把 server 写进 `cordis.patch.yml` 的 `- insert:` 段（`id: mcp-<serverName>`、`name: "@deepseek-ai/dsh-mcp-client"`）。写盘后要**重启 DSH** 才挂载，所以这一阶段状态是 `connecting` + `reason: restart-required`，不假装已连接。
2. **插件连接器**（plugin）：工具已由宿主注册，连接只是把 id 从会话 deny 集合里移除。
3. **连接器管理页**（`dsh-mcp-connector` 的 `/mcp-connector/ui`）：连接与 OAuth 授权都在那套实现里（`storages/mcp_connector.json` 的 `tables.connections` + `tables.grants`，外加 `storages/mcp_connector_grants_v1/*.json` 跨进程日志）。本插件**只读**这份状态（`readSharedConnectorState`），把「管理页已连接」显示成 `source: 'shared'` + `external` 块，并拒绝重复写 patch、拒绝假装能断开/解绑。桥接的缓存 TTL 是 5s。

会话门控：`applyToAgent(agent)` → `agent.ctx.get('tools').restrict({ deny })`。`restrict` **必须**作用在 scoped context，否则宿主直接抛错（陷阱 2）。每个 agent 一条 promise 队列（`applyQueue`），因为 `setSession()` 自己会触发 `reapply()`，用布尔锁会把紧随其后的那次调用静默丢掉（陷阱 3）。

## 4. 技能真实安装

链路：`skill/list` 或 `skill/get-by-ids` → `download_url`（已签名 CDN，约 24h）→ 下载 zip → 校验 `fingerprint`（= zip 的 sha256，形状是裸 64 位 hex 时才强校验）→ 去外层目录（也有平铺包）→ 拒绝绝对路径与 `..` → 必须有 `SKILL.md` → 写 `.staging-*` 再 `rm` + `rename` 原子替换。

**根目录不是 cwd**：DSH 的 `dsh-skill-filesystem` 用「向上第一个含 `.git` 的目录」当 projectRoot，扫 `<projectRoot>/.dsh/skills`（`src/index.ts:937-947`、`:241-260`）。所以 `projectRootOf()` 必须先把 workspace 归一到 repo 根，否则技能装成功却永远不出现在 `<available_skills>`（陷阱 4）。

装完无需重启：技能文件系统有 `watch`。但**改后端代码要重启 DSH**——`webServer.register` 只在插件激活时执行，运行中的进程不会因为文件变化多出路由（陷阱 5）。

**并发必须串行**：两次装同一个 slug 会交错 `rm(target)` 与 `rename(staging, target)`，可能留下半成品或丢掉对方的文件。`withInstallLock()` 是双层的：进程内按 target 路径排队（`installQueues`），跨进程用 `<skillsRoot>/.lock-<slug>` 目录做互斥（`mkdir` 是唯一在 Win/macOS/Linux 上都原子失败的创建原语）。锁目录 dot 前缀所以 `listInstalledSkills` 会跳过；超过 `LOCK_STALE_MS`（5 分钟）的残留锁会被打破，避免崩过的进程永久挡住后续安装（陷阱 18）。

## 4.1 连接器管理页跳转（`lib/connector-flow.js` + `recordUiOpen`）

`dsh-mcp-connector` 的 UI **只读** `location.search` 的 `uiLocale` / `locale`（`ui/index.html:1235`、`:1252`），现在不支持 `?connector=<id>` 深链。所以本插件不做假深链，但也不写死"永远不支持"：

- `detectConnectorUiDeepLink(html)` 在每个候选参数名（`DEEP_LINK_PARAM_CANDIDATES` = `connector` / `connectorId` / `configId`）上找**确凿证据**——`searchParams.get('connector')` 这类读取、或 `?connector=${…}` 这种拼装。刻意不做"包含 connector 字样"的模糊匹配，那份 HTML 里本来全是 connector。
- 控制器用 `uiCapability()` 读一次 `dsh-mcp-connector/ui/index.html`（缓存 `UI_CAPABILITY_TTL_MS` = 60s，读失败静默当不支持），据此决定 `handoff()` 与面板跳转是否带深链参数。**上游哪天支持了，本插件不改代码就会自动开始用**（升级包后一分钟内生效）。
- 不支持时：`connectorUiUrl()` 只拼可观测参数，`connectorUiHint()` 给"去管理页搜索「名字」（server: xxx）"，`oauthHandoffAction.url` 是裸 `/mcp-connector/ui`——不带没人读的参数，避免让人误以为能定位。
- 点按钮先 POST `connectors/action { action: 'openConnectorUi' }`，服务端 `recordUiOpen()` 把 `{configId, serverName, sessionId, count, at}` 记进**本插件自己的** store（`store.uiOpens`，不写对方的表），再返回 `url` / `hint` / `deepLink` / `state`；
- `state.uiOpen` 因此能显示"已去过管理页 N 次"，面板按钮变成「再次打开管理页」。这条记录**不参与** connected 判定。

## 4.2 记忆市场按 dsh-mnemon 探测（`lib/mnemon.js`）

面板里「记忆系统技能市场」这个页签**不是本插件的能力**：它只是把用户送到 `dsh-mnemon` 自己的技能管理页
（点 `[data-dsh-mnemon-entry]`，退化成两条 CustomEvent：`dsh-panel-activate` + `mnemon:anchor`）。
所以**没装 `dsh-mnemon` 就不该出现这个页签**——它会指向一个不存在的页面。

- 探测走文件系统，不走 ctx 服务：`dsh-mnemon` 只 `ctx.provide('mnemonStarterReady', true)`
  （`lib/starter.js`），那是个启动就绪标记，没有可复用的连接/技能服务面。
- 候选按序：`<profileDir>/node_modules/dsh-mnemon`（`profile`）→
  `<dshHome>/profiles/node_modules/dsh-mnemon`（`shared`）→ 只有拿不到 profileDir 时才补
  `ownProfileDir()`（`self`）。**故意不扫兄弟 profile**：别的 profile 装了 mnemon ≠ 当前会话有这个侧边栏入口。
- `readCandidate()` 要求 `package.json` 的 `name === 'dsh-mnemon'`：目录存在但没 `package.json`（半装）、
  同名空壳、坏 JSON，一律当"没装"。
- `createMnemonDetector()` 带 `DETECT_TTL_MS` = 60s 缓存，`force=true` 跳过；`profileDir` 可传函数（惰性，
  因为构造控制器时 profileDir 可能还没解析）。
- 结果形状固定 `{ available, version, path, source }`，不可用时四个字段是 `false / null / null / null`——
  面板与模型都按这个形状读，别返回 `undefined`。
- `/dsh-workbuddy-helper/state` 里 `mnemon` 这一项**失败降级为 unavailable**，不让探测异常拖垮整条路由。
  客户端 `marketIsMemory = mnemonAvailable && marketSource === 'memory'`：用户停在 memory 页签而插件被卸载时，
  渲染自动回落 WorkBuddy 市场，而不是白屏。

## 5. 验证

```powershell
node --test test/*.test.mjs          # 121 条，必须全绿
node --check lib/<file>.js           # 改完随手检
```

端到端（假模型 + 真 headless 会话，一条命令）：

```powershell
node scripts/e2e.mjs                     # 从 GitHub 装，跑全套
node scripts/e2e.mjs --source local      # 装工作树（改完代码先跑这个）
node scripts/e2e.mjs --plan connector-only --verbose
node scripts/e2e.mjs --no-regression     # 只想看会话注入，跳过已装包回归
```

退出码 0 才算通过，结论在 `.workbuddy/e2e/run/report.json`。它自己建隔离 home、复制真 home 的
连接器目录（**不含** `connections`/`grants`，那是真实凭据）、写 profile bundles、跑 dump-config 与假模型会话。

其中 `connector-UI bridge regression` 这一项跑的是 `test/connector-shared-state.test.mjs` 的 14 条，
但用的是 `WBH_LIB_ROOT=<profile>/node_modules/dsh-workbuddy-helper/lib`——**断言对象是装进去的包**，
不是工作树。同版本号不同内容（0.5.0 出现过 14165B vs 13793B）只有这一项抓得到；本地跑单测时
不设该变量即回退到 `../lib/`。细节与"为什么必须这样"见 `docs/e2e-baseline.md` §4。

打包安装（**每轮换新目录**，否则 pnpm 报 `Already up to date` 装的是旧内容）：

```powershell
npm pack --pack-destination .workbuddy\probe\pack-vN
node "C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  plugin --profile <profile> add "file:E:/DSH/workspace/migrate/.workbuddy/probe/pack-vN/dsh-workbuddy-helper-<ver>.tgz"
```

## 6. 发布纪律

每完成一处改动：`node scripts/release.mjs`（= bump patch 版 + 跑测试 + commit + push）。要 minor/major 用 `--minor` / `--major`；只想看会做什么用 `--dry-run`。

- 版本号是唯一可信的"这份代码是新的"标志，但它**不等于内容**：同版本号的 tgz 与 git 提交可能不同（历史上 0.5.0 就出现过 14165B vs 13793B），所以验证装进去的东西要 grep 特征串，别只看 version。
- `.gitignore` 必须挡住 `app-64.7z`（441MB 安装器）、`.workbuddy/`（逆向与探针产物）、`.dsh/`（装进来的技能）。

## 7. 陷阱清单（都是真踩过的）

1. 宿主 `@deepseek-ai/dsh-tools` 的 Tools 类**没有** `definitions()`。枚举工具用 `schemas()`（省略 scope = 全局视图，返回带 `name` 的模型侧 schema）。早期版本靠 `definitions()` 导致 `toolCount` 恒 0、连接器永远显示"未连接"。
2. `tools.restrict()` 要求 scoped context（`agent.ctx`）。上下文全局的 restrict 会屏蔽所有 agent，宿主直接抛错。
3. 用布尔 `applying` 做并发保护会丢更新，必须 per-agent promise 队列。
4. 技能装到非 projectRoot 目录 = 装成功但不显示。
5. 改后端路由必须重启 DSH；只有技能文件是热加载。
6. `parsePatch` 遇到空文件 `[]` 是 flow 序列，往里塞条目会写成 `{ insert: [...] }`；必须先把空序列转 block 风格，patch 才是可 review 的 diff。
7. 目录里 `servers[0]` 有三形状：`streamable-http + url`（88 条）、`stdio + command/args/env`（45 条）、`streamable-http + headerCredentialBindings`（1 条）。只支持 url 会让 45 条连接器全线报错。
8. 凭据字段来自 `auth.credentialFields`（如 amap 的 `apiKey`），`credentialBindings` 决定它落 env 还是 header。
9. `disconnect` 不能复用 `success` 分支，否则 UI 把"已断开"显示成"已连接"——`normalizeConnectResult` 有独立 `disconnected` 终态。
10. `state.reason` 只在 `stateOf()` 里，`connect()` 的返回没有 `reason`，别在测试里断言错层级。
11. `yaml.stringify` 给含 `@` 的标量加双引号，断言写 `/name: ['"]?@deepseek-ai\/dsh-mcp-client['"]?/`。
12. PowerShell 5.1 `Set-Content -Encoding utf8` 写 profile `package.json` 会带 BOM，`--dump-config` 直接失败；用 node 写，读 UTF-8 加 `-Encoding UTF8`。
13. 假模型必须说 **OpenAI Chat Completions** 方言（`POST /chat/completions` + SSE `data: {...}` … `data: [DONE]`）。Anthropic 事件形状在本 build 会 `STREAM_CLOSED`。
14. 技能目录不在 system prompt 里：它是 `@deepseek-ai/dsh-tool-skill` 注入的**独立 user 消息** `<available_skills>`。断言技能可见性别只 grep system。
15. `mcp_connector.json` 在 `$DSH_HOME/storages/`，不在 profile 下；`tables.connections` 与 `tables.grants` 是 key → record 的 map，不是数组。
16. Windows 上 `bz e` 解 7z 会静默成功但不出文件；用自带 `tar -xf app-64.7z -C <dir> <pattern>`（支持 glob，但**不支持** `--wildcards`）。
17. 凭据跟着 `DSH_HOME` 走：隔离 home 里没有 `workbuddy-vault/`，portal 的三个动作会统一报 `WORKBUDDY_HELPER_PORTAL_AUTH_REQUIRED`。要在隔离环境里跑端到端，先把真实 home 的 `workbuddy-vault/` 复制过去（4 个账号文件），别去改代码。
18. 技能安装的锁目录建在 `<skillsRoot>` 里，所以**必须先 `mkdir(root)` 再上锁**：首次安装时 `.dsh/skills` 还不存在，直接 `mkdir(<root>/.lock-<slug>)` 会 `ENOENT`。另外锁必须是"目录 + 过期时间"而不是纯进程内队列，因为面板与 `workbuddy_helper` 工具可能来自不同进程。
19. 隔离 home 里 `storages/mcp_connector.json` 不存在 → `catalogTotal` 是 0。这**不是**插件 bug（`scripts/e2e.mjs` 会从真 home 复制目录表，但故意丢掉 `connections`/`grants`）。写断言前先看目录是不是空的。
20. `dsh-mcp-connector` 的管理页现在**只读** `uiLocale`/`locale`，`?connector=<id>` 不会被解析——所以不能假装能定位到某一行。但别把这个结论写死进代码：`uiCapability()` 会探测页面文本，上游一旦开始读深链参数就自动切换（§4.1）。改这块时两个方向都要测：不支持时 URL 必须干净，支持时参数名必须跟着探测结果走。
21. 装 GitHub 源时 pnpm 会拦 git 包的 `prepare` 脚本（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` / DSH 那句 "add the exact key … under allowBuilds"）。这不是网络问题也不是插件问题，重跑一次通常就过——`scripts/e2e.mjs` 的 `installPlugin()` 已经内置"只对这个特征重试一次"，别在外面套 `for` 循环把真错误也重试掉。诊断文案用 `explainFailure()` 取带 `ERR_/pnpm:/dsh:/Error:` 的行，**不要** `stderr.slice(-400)`：曾经就是这么截出 `bhelper-e2e`（临时路径的尾巴）当"原因"的。
22. `dsh-mnemon` 存在与否要**问文件系统**，别猜 `ctx.get()`：它只 provide 了 `mnemonStarterReady` 这种标记，没有服务面。另外 `profiles/desktop` 装了不代表 `profiles/web` 也装了（实测前者有 0.5.52、后者没有），探测必须带 profileDir，否则会把"别的 profile 装了"当成"这里也有"。

## 8. 边界

- 技能市场是 UGC：`SKILL.md` 会进入模型上下文，包内 `scripts/*.py` 可能被执行。所以下载 URL 必须过 host 白名单，`fingerprint` 能校验就校验。
- 不要替 `dsh-mcp-connector` 写它的表：那份存储有跨进程日志与锁，两边同时写会丢 token。要断开/解绑就让人去管理页。
- 不要用 `while True` 轮询工具注册；`waitForTools` 有 `probeTimeoutMs` 上限。
