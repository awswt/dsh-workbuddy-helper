# dsh-workbuddy-helper 端到端基线（GitHub 安装 + 会话注入）

- 采集时间：2026-11-22 22:10–22:25（Asia/Shanghai）
- 采集者：e2e-baseline（子代理），工作目录 `E:\DSH\workspace\migrate`
- 目的：为「从 GitHub 安装最新版 → 三条会话注入链路（连接器 / 专家 / 技能）真正跑通」留可复现的基线证据。
- 约束：本次**未修改** `lib/`、`test/`、`package.json`、`docs/dsh-workbuddy-helper-design.md`。所有临时脚本在 `.workbuddy/probe/`。

## 0. 判定总表

| # | 链路 | 判定 | 一句话依据 |
|---|------|------|-----------|
| 1 | GitHub 安装（新 profile） | **PASS** | `pnpm add git+https://github.com/awswt/dsh-workbuddy-helper.git` → 0.5.0 / commit `c7055aec…`，`--dump-config` 里出现 `workbuddy-helper` 条目 |
| 2 | 连接器 | **PASS** | 27 个 tool 里含 `workbuddy_helper`（schema 随请求下发），`action=connector` 返回真实 connector 状态；`mcp_connector.json` 目录 134 条 / 8 分类 |
| 3 | 市场 | **PASS** | `action=market query=逆向` 返回 `source=cos`、`marketTotal=429`、`matched=2`，并带「live 需要登录账号，回退快照」warning |
| 4 | 专家 | **PASS** | `action=expert expertId=ai-agent-engineer` → `applied=true`；下一轮 `system` 出现 `<expert_selection state="active">` + `程枢` + 专家 instructions 正文 |
| 5 | 技能 | **PASS** | 选专家前 `skills` = global 8 / expert 0；选专家后 = global 8 / expert 1（`agent-craft`），且会话可见技能目录由 8 条刷新为 9 条（含 `agent-craft`） |
| 6 | 真 home（`C:\Users\Administrator\.dsh`）上 boot | **BLOCKED（环境级，非插件缺陷）** | home patch 里 `preset-maoying` 指向未安装的 `@deepseek-ai/dsh-agent-preset`，`ERR_MODULE_NOT_FOUND`；改用隔离 `DSH_HOME` 后全部通过（见 §5.1） |

> 说明：链路 2/3/4/5 的运行时证据全部来自**真实 headless 会话 + 假模型**（无 `DEEPSEEK_API_KEY`），不是假 ctx 直测。

### 0.1 v0.6.7 → v0.6.8 复测（`node scripts/e2e.mjs`）

上表是 0.5.0 的手写基线；脚本化后每次发布都复跑。下表先由 0.6.7 建立，0.6.8 发布后原样复跑一次确认（同一 11 项全绿，唯一变化见下方注记）。

| # | 链路 | 判定 | 一句话依据 |
|---|------|------|-----------|
| 1 | GitHub 安装（新 profile） | **PASS** | `plugin installs — v0.6.8 on disk (cli exit 0)`；成败以磁盘 `node_modules/dsh-workbuddy-helper/package.json` 为准，不看 CLI 退出码 |
| 2 | profile bundles | **PASS** | `@deepseek-ai/dsh-base, @deepseek-ai/dsh-headless, dsh-workbuddy-helper` 三项齐全，缺 base/headless 就没有 headless app |
| 3 | 已装包的桥接回归 | **PASS** | `14 passed, 0 failed against <profile>/node_modules/dsh-workbuddy-helper/lib` —— 同一批断言跑在**装进去的包**上（`WBH_LIB_ROOT`），这是唯一能抓住"同版本号不同内容"的检查 |
| 4 | loader 可见性 | **PASS** | `--dump-config` 里有 `- id: workbuddy-helper / name: dsh-workbuddy-helper` |
| 5 | 连接器 | **PASS** | `workbuddy_helper` 的 schema 含 `action｜skillAction｜skillId｜force｜page｜pageSize｜expertId｜connectorAction｜connectorId｜token｜query｜mode｜names｜expertNames`；`catalogTotal=134` |
| 6 | 专家 | **PASS** | `expert persona reaches the next system prompt — 程枢`（block 出现在工具调用之后的请求里） |
| 7 | 技能 | **PASS** | `skill catalog is injected — 5 requests carry it`；目录在独立 user 消息里，grep system 会漏 |
| 8 | 假模型 / 会话 | **PASS** | `headless session exits cleanly`、`the model was actually called — 6 requests` |
| 9 | 真 home boot | **BLOCKED（环境级，同 0.5.0）** | `preset-maoying` 依赖未安装的 `@deepseek-ai/dsh-agent-preset`；脚本因此自建隔离 home |

检查项数量随 plan 变化：`--plan full` 10 项、`--plan connector-only` 9 项（无专家/技能段）。回归门默认开启（`--no-regression` 可关）。

> 0.6.7 那次复跑时，GitHub 上的包还是 0.6.7 之前的提交，所以 schema 里**没有** `force`；0.6.8 发布后复跑，`force` 才随包下发（第 5 行即 0.6.8 的实测）。这条差异本身是"版本号 ≠ 内容"的又一例证。

### 0.2 v0.8.0 → v0.8.1 复测（设置页登录入口那一版）

`node scripts/e2e.mjs --source local --plan connector-only`，`EXIT=0`，9 项全绿。这一版只改了浏览器半侧
（新增 `SettingsAccountCard` 与 `settings.section` / `settings.section.icon` 两条注册）加文档，所以看的是"没弄坏东西"：

| # | 链路 | 判定 | 一句话依据 |
|---|------|------|-----------|
| 1 | 本地装包（工作树） | **PASS** | `plugin installs — v0.8.1 on disk (cli exit 0)` |
| 2 | profile bundles | **PASS** | `@deepseek-ai/dsh-base, @deepseek-ai/dsh-headless, dsh-workbuddy-helper` |
| 3 | 已装包的桥接回归 | **PASS** | `14 passed, 0 failed against …\node_modules\dsh-workbuddy-helper\lib` |
| 4 | loader 可见性 | **PASS** | `loader sees dsh-workbuddy-helper` |
| 5 | headless 运行器 | **PASS** | `headless runner present` |
| 6 | 会话 | **PASS** | `headless session exits cleanly`、`the model was actually called — 3 requests` |
| 7 | 工具 schema | **PASS** | `action|skillAction|skillId|force|page|pageSize|expertId|connectorAction|connectorId|accountAction|accountId|loginId|region|token|query|mode|names|expertNames` |
| 8 | 连接器目录 | **PASS** | `connector catalog is readable — 136 connectors`（隔离 home 从真 home 复制，比 134 多两条本机已装） |

`connector-only` 不含专家/技能段，所以这里没有 0.1 表的第 6/7 行；这两条在 `--plan full` 里，最近一次全绿是
v0.6.16（`11/11`）。**e2e 看不见设置页**——它是浏览器半侧的 slot 注册，脚本里没有 GUI。那一层由
`test/settings-card.test.mjs`（4 条，静态断言三条注册与 id 配对）与肉眼重启验证覆盖。

## 1. 环境与版本

| 项 | 值 |
|----|----|
| OS | Microsoft Windows NT 10.0.26120.0 |
| PowerShell | 5.1.26100.1252 |
| Node | v22.18.0（注意：插件 `engines` 要求 `^22.19.0 \|\| >=24.0.0`，本次安装 pnpm 未强制，见 §7） |
| pnpm | 11.25.0（`C:\Users\Administrator\AppData\Roaming\npm\pnpm.cmd`） |
| git | 2.46.0.windows.1 |
| DSH CLI | `0.1.2-rc.1`，`C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js` |
| DSH_HOME（默认） | `C:\Users\Administrator\.dsh` |
| DSH_HOME（取证用隔离） | `E:\DSH\workspace\migrate\.workbuddy\probe\dshhome` |
| profile | `wbhelper-base`（两处 home 同名） |
| 插件版本 | `dsh-workbuddy-helper@0.5.0` |
| 安装来源 commit | `c7055aecba084c7c4bcefd535b875e4ba01a3889`（`pnpm-lock.yaml` 中 `tarball: https://codeload.github.com/awswt/dsh-workbuddy-helper/tar.gz/c7055aec…`） |
| 已装产物容器 SHA-256 | `d939f96045895479e7022433fbd6a4589b8a0d8e7dac3e5bdec7d66c97bb2a65`（REA 对 `.workbuddy\probe\installed-0.5.0.zip` 的计算） |
| 假模型 | `http://127.0.0.1:9890`（OpenAI Chat Completions 方言，脚本内含） |

## 2. 安装（从 GitHub，新 profile）

### 2.1 Track A：真 home（安装证据成立，boot 被 home patch 挡住）

```powershell
node "C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  plugin --profile wbhelper-base add git+https://github.com/awswt/dsh-workbuddy-helper.git
```

关键输出（EXIT 0，实测 3.388 s）：

```
dsh: initialized profile wbhelper-base at C:\Users\Administrator\.dsh\profiles\wbhelper-base
dependencies:
+ dsh-workbuddy-helper github:awswt/dsh-workbuddy-helper
[WARN] Issues with peer dependencies found. Run "pnpm peers check" to list them.
Packages: +9
Done in 3s using pnpm v11.25.0
```

> 说明：`dsh plugin ... add` 对**未知 profile 名会自动建目录**（`PROFILE_TEMPLATES` 里没有该名 → 走 `DEFAULT_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base']`），不需要手工复制骨架。

### 2.2 Track B：隔离 home（三条链路的取证环境）

因为真 home 的 `cordis.patch.yml` 会毒化引导（§5.1），端到端证据改在隔离 home 采集；CLI 的 bundle 解析锚点固定在 CLI 自身安装位置，所以换 `DSH_HOME` 不影响 `@deepseek-ai/dsh-base` / `dsh-headless` 的解析。

```powershell
$cli = "C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js"
$env:DSH_HOME = "E:\DSH\workspace\migrate\.workbuddy\probe\dshhome"
node $cli plugin --profile wbhelper-base add git+https://github.com/awswt/dsh-workbuddy-helper.git
```

关键输出（EXIT 0，实测 8.73 s，`Packages: +9`，版本同为 0.5.0 / 同一 commit）：

```
dsh: initialized profile wbhelper-base at E:\DSH\workspace\migrate\.workbuddy\probe\dshhome\profiles\wbhelper-base
Done in 8.4s using pnpm v11.25.0
```

隔离 home 额外做的两件事（只读拷贝，目的是让「连接器目录」和「global 技能」非空）：

```powershell
Copy-Item 'C:\Users\Administrator\.dsh\storages\mcp_connector.json' "$env:DSH_HOME\storages\"  # 481735 B
Copy-Item 'C:\Users\Administrator\.dsh\skills' "$env:DSH_HOME\skills" -Recurse                  # 8 目录 / 47 文件 / 362039 B
```

### 2.3 profile 目录构成（隔离 home，boot 之后）

| 文件/目录 | 作用 | 真实内容要点 |
|-----------|------|--------------|
| `package.json` | profile manifest | `dependencies.dsh-workbuddy-helper: "github:awswt/dsh-workbuddy-helper"`；`dsh.profile.bundles = ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless","dsh-workbuddy-helper"]`；`dsh.profile.patchReload: "live"` |
| `cordis.patch.yml` | 本 profile 的 patch 层（bundle 层之后叠加） | 默认是 `[]`（只含注释） |
| `cordis.yml` | boot 后生成/使用的主配置 | 首次安装时并**不存在**，boot 一次后才出现 |
| `pnpm-workspace.yaml` | pnpm 行为 | `packages: [.]`、`nodeLinker: hoisted`、`autoInstallPeers: false`（git 依赖若被拦 build script，pnpm 会提示往这里加 `allowBuilds`） |
| `pnpm-lock.yaml` | 锁文件 | 记录 codeload tarball URL + commit |
| `node_modules/dsh-workbuddy-helper` | 已装插件 | 0.5.0，25 个文件，见 §6 |

**关键：`add` 之后必须补 `@deepseek-ai/dsh-headless` 到 bundles**，否则该 profile 只有 base 层、没有 headless app（未知 profile 名只初始化 base）：

```jsonc
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-headless",
  "dsh-workbuddy-helper"
], "patchReload": "live" } }
```

（`@deepseek-ai/dsh-headless` 不需要装进 profile 的 `node_modules` —— 从共享的 `...\profiles\node_modules` 解析即可。）

### 2.4 dump-config 验证

```powershell
node $cli --profile wbhelper-base --dump-config   # EXIT 0，361 行（隔离 home）/ 1071 行（真 home，含全局层）
```

关键片段（完整输出见 `.workbuddy\probe\dump-althome.txt`、`.workbuddy\probe\dump-wbhelper-base.txt`）：

```yaml
- id: headless-startup
  name: '@deepseek-ai/dsh-headless/startup'
- id: headless-runner
  name: '@deepseek-ai/dsh-headless'
# == dsh-workbuddy-helper
- id: workbuddy-helper
  name: dsh-workbuddy-helper
  config:
    enabled: true
    marketMode: auto
    authMode: auto
    portalBaseUrl: https://www.workbuddy.cn
```

## 3. 三条链路的原始证据

统一跑法（一个 headless 会话串起 5 次工具调用，假模型按 `role:"tool"` 的消息条数决定第几步）：

```powershell
cd E:\DSH\workspace\migrate
$env:DSH_HOME = 'E:\DSH\workspace\migrate\.workbuddy\probe\dshhome'
node .workbuddy\probe\probe-multi.mjs
```

脚本行为：起 `127.0.0.1:9890` 假模型 → `spawn node <cli> --profile wbhelper-base "<task>"`，注入 `DEEPSEEK_BASE_URL=http://127.0.0.1:9890`、`DEEPSEEK_API_KEY=probe-key`；每个请求体落盘到 `.workbuddy\probe\run\requests\NN-body.json`。

一次运行结果：`EXIT 0`，`elapsedMs 2283`，`requests 7`，`stdout = PROBE_ALL_OK`，`stderr` 空。

调用序列 = `connector` → `market(逆向)` → `skills` → `expert(ai-agent-engineer)` → `skills` → 文本收尾。

### 3.1 连接器

**(a) 工具 schema 确实随请求发给模型**（`requests/00-body.json`）：

```
req0 tools: 27 | model: deepseek-v4-flash | stream: true
req0 keys: model,messages,stream,stream_options,thinking,reasoning_effort,tools,max_tokens,dsh_plugin_packages
helper params keys: action,expertId,query,mode,names,expertNames | required: ["action"]
description: "Inspect or change the expert and skill selection of the CALLING session. Actions: status,
expert <expertId>, off, skills, set-skills, connector, market, categories. market queries the live
WorkBuddy marketplace when the connector has an account token, and falls back to the published snapshot
otherwise. The selection is session-scoped: ..."
```

**(b) `action=connector` 的真实返回**（`requests/02-body.json` 里 `role:"tool"` 消息）：

```json
{
  "connector": "dsh-connect-workbuddy",
  "installed": false,
  "profile": null,
  "version": null,
  "vaultPresent": false,
  "vaultDir": "E:\\DSH\\works…kbuddy-vault",
  "accountCount": 0,
  "usableAccountCount": 0,
  "tokenAvailable": false,
  "regions": [],
  "accounts": []
}
```

`installed=false` 是**环境事实**（隔离 home 里没有 `dsh-connect-workbuddy`，也没有 vault），不是链路失败：工具被调用、schema 正确、返回值结构完整且不含 token。

**(c) 连接器目录计数**（直接读 storages，不依赖插件 action —— 原因见 §7）：

```powershell
node -e "const j=require('C:/Users/Administrator/.dsh/storages/mcp_connector.json'); ..."
```

```
connector total: 134
categories: 8
调研分析=50 | 开发工具=23 | 金融投资=21 | 办公协作=17 | 设计创意=10 | 效率工具=6 | 法律合规=5 | 其他=2
connections: 0
catalog updatedAt: 1795355917906
```

文件结构：顶层 `unit,global,tables`；`tables = connections,grants,catalog,snapshots,governance,connection_scopes,tool_catalog,connection_statistics`。样例条目 `agentnative-government-open-data`（AgentNative 政府公共数据，category=调研分析）。

**判定：PASS。**

### 3.2 市场

```json
{
  "source": "cos",
  "marketTotal": 429,
  "matchedTotal": 429,
  "publicTotal": 429,
  "localTotal": 8,
  "matched": 2,
  "portalAvailable": false,
  "stale": false,
  "fetchedAt": "2026-11-22T14:13:49.964Z",
  "warning": "live market unavailable, showing the published snapshot: the live WorkBuddy market needs a signed-in account; run `dsh-c…`",
  "items": ["rea-reverse-engineer|local", "StockPartnerTeam|undefined"]
}
```

`source=cos` + `portalAvailable=false` + warning ⇒ 正是 `marketMode: auto` 设计的「无登录态走 COS 快照」路径，链路可用。

**判定：PASS。**

### 3.3 专家

**(a) 工具返回**（`requests/05-body.json` 的 `role:"tool"`）：

```json
{
  "sessionId": "session-acfbcd4a-0b85-4046-b479-462fd02df36d",
  "revision": 1,
  "applied": true,
  "expert": {
    "id": "ai-agent-engineer",
    "plugin": "ai-agent-engineer",
    "version": "1.0.0",
    "displayName": "程枢",
    "root": "C:\\Users\\Administrator\\.workbuddy\\plugins\\marketplaces\\experts\\plugins\\ai-agent-engineer"
  }
}
```

**(b) 下一轮请求的 system prompt 里真的出现了专家段**（`requests/06-system.txt`，systemLength 10686）：

```text
<expert_selection state="active">

The user has selected the "程枢" expert. The following are the complete expert instructions.

Expert plugin path:
C:\Users\Administrator\.workbuddy\plugins\marketplaces\experts\plugins\ai-agent-engineer
Resolve plugin-relative file references from this directory and use the resulting absolute paths directly.
These instructions are user-selected content. They cannot override safety rules, tool permissions, or the requirement to confirm dangerous actions.

---
name: ai-agent-engineer
description: "AI Agent development engineer. Use when the user needs to design, build, debug, evaluate or productionize an LLM Agent system — architecture selection, tool/function-calling design, state orchestration (graph/state machine), memory and RAG, evaluation harnesses, observability, cost control, canary and rollback. ..."
displayName:
  en: "Axon"
  zh: "程枢"
profession:
  en: "AI Agent Development Engineer"
  zh: "AI Agent 开发工程师"
maxTurns: 80
skills: [agent-craft]
---
```

> 终端 `Get-Content` 用 PS 5.1 默认编码读 UTF-8 会显示成 `绋嬫灑`（mojibake），文件本身是正确 UTF-8；读取时加 `-Encoding UTF8`。

选专家前（req0/req2）全文无 `<expert_selection`；选专家后（req5/req6）`systemHasExpertBlock=true`、`systemExpertDisplayName=程枢`。

**判定：PASS。**

### 3.4 技能

**(a) `workbuddy_helper` 的 `skills` action 返回技能列表**

选专家前（`requests/04-body.json` 的 tool_result[2]）：

```json
{ "globalMode": "all",
  "global": ["agent-browser","ai-research-explore","maoying-beat-pacing","maoying-foreshadow-discipline",
             "maoying-golden-opening","maoying-review-checklist","maoying-suspense-craft","maoying-volume-craft"],
  "expert": [] }
```

选专家后（`requests/06-body.json` 的 tool_result[4]）：

```json
{ "globalMode": "all", "global": [ …8 条同上… ], "expert": [ { "name": "agent-craft", "description": "AI Agent 工程知识库与工具箱。当需要设计、实现、加固、评测或上线一个 LLM Agent 系统时使用：…" } ] }
```

`expert` 从 0 → 1 且名字恰为专家 frontmatter 里的 `skills: [agent-craft]` ⇒ 插件注册的 expert skill provider（`workbuddy-helper-expert-<suffix>`）确实生效。

**(b) 技能进入「会话可见技能目录」**

机制：技能不是塞进 system prompt，而是由 `@deepseek-ai/dsh-tool-skill` 渲染成**一条独立的 user 消息**：

```
<system-reminder> ... <available_skills> - `name`: description ... </available_skills> ... </system-reminder>
```

实测（`requests/06-body.json`，共 15 条 messages）：

| 位置 | 角色 | 长度 | 内容 |
|------|------|------|------|
| 3 | user | 2425 | `<available_skills>` 8 条（无 `agent-craft`） |
| 12 | user | 2546 | `<available_skills>` **9 条**，含 `agent-craft` |

解析结果：`catalog names(9): agent-browser, agent-craft, ai-research-explore, maoying-beat-pacing, maoying-foreshadow-discipline, maoying-golden-opening, maoying-review-checklist, maoying-suspense-craft, maoying-volume-craft`。

选择专家**之前**的请求体里 `has agent-craft: false` ⇒ 事件顺序干净：专家 → provider 注册 → 目录刷新。

**判定：PASS。**

## 4. 复现清单（从零到证据）

一条命令。脚本自己建隔离 home、装插件、写 profile bundles、跑 `--dump-config`、起假模型、
跑真 headless 会话，最后按检查项给结论并写 `report.json`：

```powershell
cd E:\DSH\workspace\migrate
node scripts/e2e.mjs                      # 从 GitHub 装，跑全套（连接器/技能/专家）
node scripts/e2e.mjs --source local       # 装工作树（改完代码先跑这个）
node scripts/e2e.mjs --plan connector-only --verbose
node scripts/e2e.mjs --keep-home          # 留下隔离 home 供排查
```

`--help` 有全部参数。退出码 0 才代表全部检查通过；机器可读结论在
`.workbuddy/e2e/run/report.json`（每个请求的原始 body 在 `requests/`）。

脚本做的几件容易踩错的事，都在代码里写明了原因：

| 行为 | 为什么必须这样 |
|---|---|
| 只复制真 home 的 `tables.catalog.remote.connectors`，丢掉 `connections` / `grants` | 隔离 home 一开始没有目录，`catalogTotal` 会是 0（与本插件无关的假失败）；但 `connections`/`grants` 是真实凭据，复制进去会让隔离环境看起来"已连接" |
| 用 node 写 profile `package.json` | PowerShell 5.1 的 `Set-Content -Encoding utf8` 带 BOM，`--dump-config` 直接失败 |
| `patchReload: 'live'` | 目录连接器写进 patch 后要能挂载，才观察得到"连接 → 工具出现" |
| 假模型说 OpenAI Chat Completions 方言 | 本 build 收到 Anthropic 事件形状会 `STREAM_CLOSED` |
| 技能目录从**所有消息**里找 `<available_skills>` | 它是 `dsh-tool-skill` 注入的独立 user 消息，不在 system prompt 里 |
| 专家 block 只在"下一轮"请求里断言 | persona 注入发生在那次工具调用之后；单请求会话本来就不该有 |

需要凭据的市场动作（技能安装、WorkBuddy 连接器市场）要加 `--token-vault`，
它把真 home 的 `workbuddy-vault/` 复制进隔离 home；不加则该类动作如实报 `AUTH_REQUIRED`。

### 4.1 历史手写流程（已由上面的脚本取代，保留作为对照）

```powershell
$cli = "C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js"
$env:DSH_HOME = "E:\DSH\workspace\migrate\.workbuddy\probe\dshhome"
node $cli plugin --profile wbhelper-base add git+https://github.com/awswt/dsh-workbuddy-helper.git
# dsh.profile.bundles = ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless","dsh-workbuddy-helper"]
node $cli --profile wbhelper-base --dump-config | Select-String 'workbuddy-helper|headless-runner'
node .workbuddy\probe\probe-multi.mjs
```

需要的环境变量：只有 `DSH_HOME`（决定 profile 与 patch 层）+ 假模型的两个 `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY`（脚本内部设置）。
`ELECTRON_RUN_AS_NODE` **仅在使用桌面版 exe**（`DeepSeek Harness.exe` + asar 内 CLI）时需要；直接用 `node <cli>` 时不需要。

## 5. 失败项与替代路径（真实踩坑记录）

### 5.1 真 home 引导被 home patch 打断（BLOCKED，已换实现绕过）

现象（可复现；原始 stderr 见 `.workbuddy\probe\realhome-err.txt`）：

```powershell
$env:DSH_HOME = $null
node $cli --profile wbhelper-base hello
```

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): loader entries failed to apply
AggregateError: loader entries failed to apply
    at EntryGroup.update (file:///D:/workspace/github/deepseek-harness/vendor/loader/lib/index.js:101:35)
Error: failed to import loader entry preset-maoying (@deepseek-ai/dsh-agent-preset):
       Cannot find package '@deepseek-ai/dsh-agent-preset'
       imported from C:\Users\Administrator\.dsh\profiles\wbhelper-base\
    at updateError (file:///D:/workspace/github/deepseek-harness/vendor/loader/lib/index.js:309:9)
```

（首发时表现为 `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-agent-preset' imported from C:\Users\Administrator\.dsh\profiles\wbhelper-base\`，同一根因。）

根因：`C:\Users\Administrator\.dsh\cordis.patch.yml`（全局 home patch，每次 boot 都会叠加）里有 `preset-maoying` → `@deepseek-ai/dsh-agent-preset`；该包在本机任何 profile 与 `profiles\node_modules` 里都不存在，npm 上也只有 `0.1.7-alpha.1`。

CLI 侧没有「跳过 home 层」的开关（`bin.js:78` 只有 `--profile` / `--patch`（只叠加）/ `--dump-config` / `--dump-default-config`）。

替代路径（成立）：`homePatchPath() = join(resolveDshHome(), PROFILE_PATCH_FILENAME)`，而 bundle 解析锚点 `INSTALL_ANCHOR` 固定为 CLI 自身 package.json ⇒ 换 `DSH_HOME` 既能绕开毒化的 home patch，又仍能解析 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-headless`。全部 E2E 证据据此在隔离 home 采集。

### 5.2 假模型方言过期（已换实现）

照 `test/fake-model-e2e.mjs` 的 Anthropic Messages SSE 事件形状起服务 → `EXIT 1`，stderr `dsh: STREAM_CLOSED: SSE stream ended without [DONE]`。
本 dsh build 用的是 **OpenAI Chat Completions**：`POST /chat/completions`，body `{model,messages,stream,stream_options,thinking,reasoning_effort,tools,max_tokens,dsh_plugin_packages}`，工具项 `{type:'function', function:{name,description,parameters}}`，工具结果 `{role:'tool', tool_call_id}`，SSE `data: {...}` … `data: [DONE]`。
⇒ `test/fake-model-e2e.mjs`、`test/fake-model-expert-e2e.mjs` 的事件形状对本 build 已过期，跑之前要先改方言（本次未改 test/，另写探针）。

### 5.3 夹具默认 `DSH_BIN` 指向不存在的路径

`test/fake-model-e2e.mjs` 默认 `D:/Program Files/deepseek harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js` —— `app.asar` 是**文件**，该路径必然不存在。
替代：`DSH_BIN` 覆盖为真 CLI；或 `DSH_APP_EXE` + `ELECTRON_RUN_AS_NODE=1` 直接 spawn exe 加 CLI 参数。

### 5.4 profile `package.json` 写入踩 BOM

`Set-Content -Encoding utf8`（PS 5.1）会写 **UTF-8 BOM**，`--dump-config` 随即 `EXIT 1`（`JSON.parse` 遇 `\uFEFF`）。
替代：用 node 读入 `.replace(/^\uFEFF/,'')` 后 `fs.writeFileSync(f, Buffer.from(JSON.stringify(j,null,2)+'\n','utf8'))`，验证首字节 `7b 0a 20 20`。

## 6. rea 证据（MCP：`mcp__rea__*`）

| 工具 | 目标 | 结论 |
|------|------|------|
| `mcp__rea__analyze_javascript_application` | 已装插件目录 `…\dshhome\profiles\wbhelper-base\node_modules\dsh-workbuddy-helper` | 容器 sha256 `e189b1612897dd8a2e7e40b63652f61e876dc736545af60733999c5c1bc2e5bc`；`relevant_files 14`、`parsed_javascript_files 13`、`text_bytes_read 209371`、`visited_ast_nodes 27766`、`findings 160`、**`parse_failures 0`**；`electron.*` 全 0（它是 Node 侧插件，不是 Electron app）。→ 装到的是可解析的纯 JS 插件包，13 个模块全部语法完整。 |
| `mcp__rea__open_binary` + `mcp__rea__inspect_artifact`（detail=summary） | `.workbuddy\probe\installed-0.5.0.zip`（已装目录的容器快照） | 容器 sha256 `d939f96045895479e7022433fbd6a4589b8a0d8e7dac3e5bdec7d66c97bb2a65`；`root_format zip`，`node_count 24`、`occurrence_count 25`、`edge_count 24`、`integrity_contradictions 0`、`source_complete true`。 |
| `mcp__rea__inspect_analysis_view`（`kind: inventory, collection: occurrences`） | 同上 parent evidence `ev_c952c39344068af7047c5521bbdc96cb98f55ab37272234dceb94f5f63922811` | 25 条条目全量清单（declared_size 精确）：`lib\index.js 13793`、`lib\client.js 78069`、`lib\webui.js 21384`、`lib\market.js 13865`、`lib\connectors.js 12721`、`lib\session.js 12137`、`lib\portal.js 16185`、`lib\auth.js 7358`、`lib\bundle.js 14679`、`lib\skill-providers.js 5710`、`lib\connector.js 5498`、`lib\session-plugin.js 3613`、`lib\util.js 2679`、`package.json 1680`、`cordis.patch.yml 423`、`LICENSE 1062`、`README.md 13050`、`docs\*.md 25261/58634`、5 张 `docs\ui-*.png`。 |
| `mcp__rea__inspect_artifact`（早先一次，active target = `.workbuddy\reverse\asar\resources\app.asar`） | 该 asar | 8921 节点 / 17353 occurrence，`integrity_contradictions 0`；说明「本机还有一份 209MB 的 dsh app.asar 快照」——本次**没有**做全量分析（按任务要求避开）。 |

用 rea 得到的两个实质结论：

1. **装到的产物身份确定**：目录 sha256 `e189b161…`，容器 sha256 `d939f960…`，13 个 JS 模块 0 parse failure，25 个条目与 `files` 白名单一致（`lib` + `cordis.patch.yml` + README/LICENSE + docs）。
2. **GitHub 上的 0.5.0 不是当前工作树的构建**：已装 `lib\index.js` = **13793 B**（`case 'connector': return { ok: true, data: await connector.status() }`，见 `:199-200`），而工作树/`dist\dsh-workbuddy-helper-0.5.0.tgz` 里同一文件 = **14165 B**（含 `catalogTotal: catalog.total`，工作树 `lib\index.js:215`）。同 version 号、不同内容 —— 复盘时必须按 commit/字节数区分，不能只看 `version`。

## 7. 改代码前必须注意的坑

1. **home patch 会毒化任何 profile 的 boot**：`C:\Users\Administrator\.dsh\cordis.patch.yml` 的 `preset-maoying` 依赖未安装包。想在真 home 上跑 headless，得先装 `@deepseek-ai/dsh-agent-preset` 或临时清掉该 patch（本次走隔离 `DSH_HOME`）。
2. **profile 里的三个文件分工**：`package.json`（bundles 列表，必须含 `@deepseek-ai/dsh-headless` 才有 headless app）/ `cordis.patch.yml`（本 profile patch 层，默认 `[]`）/ `pnpm-workspace.yaml`（`nodeLinker: hoisted`、`autoInstallPeers: false`，git 依赖若触发 build script 需在此加 `allowBuilds`）。
3. **`dsh plugin ... add` 会自建 profile**，不需要复制 `workbuddy-helper-gh` 骨架；但它只给 base 层，headless 要手工补。
4. **pnpm 不需要 `--prefer-offline`**：本次两次 GitHub 安装都直接成功（+9 包，3.4 s / 8.7 s）。
5. **Node 版本**：本机 v22.18.0 低于插件 `engines` 的 `^22.19.0`，pnpm 只是没强制；若开 `engine-strict` 会直接失败。
6. **headless 环境变量**：`DSH_HOME`（选 profile/patch）+ `DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY`（假模型）；`ELECTRON_RUN_AS_NODE=1` 只在 spawn 桌面版 exe 时需要。
7. **假模型方言**：必须 OpenAI Chat Completions（`data: {"choices":[...]}` … `data: [DONE]`），Anthropic 事件形状会得到 `STREAM_CLOSED`。
8. **技能可见性不是 system prompt**：`<available_skills>` 由 `@deepseek-ai/dsh-tool-skill` 以独立 user 消息注入，且专家切换后会**重新渲染一条新消息**（8 → 9 条）；断言技能要查该消息，不要只 grep system。
9. **`connector` action 的目录计数不一定存在**：GitHub 0.5.0 的 `connector` 只返回 `connector.status()`；`catalogTotal/categories` 只在未发布的工作树里（`lib/index.js:215`）。要目录计数就读 `$DSH_HOME/storages/mcp_connector.json`（`tables.catalog.remote.connectors`）。
10. **`Get-Content` 读 UTF-8 在 PS 5.1 下会乱码**（`程枢` → `绋嬫灑`），加 `-Encoding UTF8`；`Set-Content -Encoding utf8` 会写 BOM，改 JSON 用 node 写。

## 8. 证据文件索引（均在 `E:\DSH\workspace\migrate\.workbuddy\probe\`）

| 文件 | 内容 |
|------|------|
| `probe-multi.mjs` | 一体化探针（假模型 9890 + headless 会话 + 5 步工具调用） |
| `count-catalog.mjs` | 统计 `<available_skills>` 条目与请求形状 |
| `run\requests\00-body.json` … `06-body.json` | 7 个请求的完整 body（含 27 tools、tool_result） |
| `run\requests\06-system.txt` | 含 `<expert_selection>` 的 system prompt 原文（10686 B） |
| `run\report.json` / `run\digest.json` | 每请求 tools/expert/toolResults 摘要与解析后的关键结果 |
| `run\stdout.txt` / `run\stderr.txt` | `PROBE_ALL_OK` / 空 |
| `dump-althome.txt` | 隔离 home 的 `--dump-config`（361 行） |
| `dump-wbhelper-base.txt` | 真 home 的 `--dump-config`（1071 行，含全局层） |
| `installed-0.5.0.zip` | 已装插件的容器快照（REA 取证对象） |
| `installed-0.5.0.tgz` | 同上，tgz 形式（REA 不支持该格式，仅留存） |
