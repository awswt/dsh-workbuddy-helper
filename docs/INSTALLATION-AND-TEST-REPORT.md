# dsh-workbuddy-helper 迁移、安装方式与专家市场核查报告（v2 修正）

- 日期：2026-11-22
- 仓库：`git@github.com:awswt/dsh-workbuddy-helper.git`
- 分支：`main`
- 宿主：DeepSeek Harness `0.2.2-rc.5`
- 本版重点：修正上一版把“公开快照 429 条”误当成“WorkBuddy 专家市场”的结论

---

## 1. 结论

| 问题 | v2 结论 |
|---|---|
| 本地专家是不是自定义的 | 不是。`rea-reverse-engineer`、`senior-fullstack-engineer`、`ai-agent-engineer` 的 WorkBuddy 市场 ID 分别是 `ex_QvM298ih8T8g`、`ex_ps4s7tycOR2g`、`ex_zYK6DThTcjqH`，都能在在线市场按 ID 查到 |
| 公开市场能否找到截图里的专家 | 能。截图中的 9 位专家，7 位可精确命中名称，2 位只找到相近职业名（详见第 3 节） |
| 429 是什么 | 是 CDN 上 `expert_center.json` 的条数，属于周期性**快照**，`lastUpdated=2026-08-18`；不是 App 的市场全量 |
| 是不是找错了市场入口 | 是。App 实际调用 `POST https://www.workbuddy.cn/portal/operation-platform/market/expert/list`，需要账号 token；未过滤 `total_count=10000`，16 个分类 |
| 插件是否已修正 | 已新增在线市场客户端，默认在线优先、快照兜底；ZIP 专家包、分类、详情、下载全部打通 |

一句话：**上一版的 429 条没有错，但它是快照的子集；把它称为“公开市场全量”是错的。** 在线市场才是你在 WorkBuddy 里看到的列表。

---

## 2. 两个市场入口的实测差异

### 2.1 在线市场（App 实际使用）

```text
POST https://www.workbuddy.cn/portal/operation-platform/market/expert/list
Authorization: Bearer <connector accessToken>
Content-Type: application/json

{"page":1,"page_size":100,"sort_by":"reco_rank","sort_order":"desc"}
```

实测：

| 项 | 值 |
|---|---|
| 无 token | HTTP 401，`invalid_token` |
| 带 connector token | HTTP 200，`code=0` |
| `total_count` | `10000` |
| 分页 | 100 条/页；第 1–100 页有数据，第 101 页返回 0 条 |
| 分类 | 16 个（`GET /portal/operation-platform/market/expert-categories`） |
| 详情 | `POST /portal/operation-platform/market/expert/get-by-ids`，body `{expert_ids:[...], include_invisible:true}` |
| 下载 | `POST /portal/operation-platform/market/expert/download-url` → 签名 ZIP，CDN `openplatform-cdn.codebuddy.cn` |

### 2.2 公开快照（CDN）

```text
GET https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace/expert_center.json
```

| 项 | 值 |
|---|---|
| HTTP | 200 |
| 字节数 | 1,158,100 |
| manifest version | `1.0.0` |
| lastUpdated | `2026-08-18T03:00:00Z` |
| experts | 429（唯一 id 429，无重复） |
| categories | 15 |

### 2.3 为什么上一版会错

上一版从 WorkBuddy 安装包里搜到了 `expert-marketplace` 这个 CDN 路径，验证了 200 与 429 条，就把它当成市场全量。实际上安装包里同时存在两套来源：

- `expert_center.json`：离线快照 / builtin 兜底；
- `/portal/operation-platform/market/*`：在线市场，渲染进程实际使用。

App 的专家页还会把“在线市场 + 已安装”合并显示，所以本机已安装专家在 UI 里看起来也像市场条目。数据源判断错，才会得出“429 条里没有逆向专家”的错误结论。

---

## 3. 截图中专家的逐一核对

用在线市场关键词接口逐条查询（2026-11-22）：

| 截图卡片 | 在线市场结果 | 结果 |
|---|---|---|
| 资深 Java 技术专家 | `ex_4e7cNzaTR1Id`，plugin `java-senior-dev` | 精确命中 |
| 高级全栈工程师 | `ex_ps4s7tycOR2g`，plugin `senior-fullstack-engineer` | 精确命中；本机已安装 |
| Java 后端开发工程师 | `ex_yO1NvwR8YHpP`，plugin `java-backend-engineer-wshbin`；另有 5 条同义 | 命中 |
| Java 全栈架构师 | `ex_cCVrQDG9ERCw`，profession `资深Java全栈架构师` | 命中 |
| 资深小程序全栈技术 | `ex_93kHtMBqaI0K`，profession `资深小程序全栈技术负责人` | 命中 |
| Java 技术专家PRO | 未找到同名；`Java` 关键词 75 条中无 `PRO` 后缀 | 未精确命中 |
| Java 讲师 / 后端架构师 | `ex_675KLIQp34I8`，profession 完全一致 | 精确命中 |
| 资深平台架构与微服务 | 未找到同名；`资深平台` 30 条、`微服务` 79 条中无该名称 | 未精确命中 |
| 资深后端开发专家 | `资深后端开发专家` 返回 12 条（PHP/ThinkPHP 等） | 命中同义职业名 |

说明：两张未精确命中的卡片可能是账号/企业范围内可见、名称带空格或版本后缀，或截图来自另一个账号的推荐位；这不影响“这些专家来自在线市场”的判断。

### 3.1 “软件逆向分析工程师”

```text
keyword=软件逆向分析工程师 -> total=5
ex_QvM298ih8T8g  REA 逆向功能分析专家
                 profession: 软件逆向分析工程师
                 plugin: rea-reverse-engineer
                 version: 1.0.0
                 use_count: 237361
```

同一关键词还返回：

- `ex_tqxz6GGmspUV` 软件逆向专家
- `ex_p6eSKdupTrOw` REA逆向软件工程师
- `ex_RZjwzIDGU0bW` 逆向工程师
- `ex_5HYwXIYZ7cGf` 可信软件生产专家

`keyword=逆向` 返回 159 条。

### 3.2 本机专家的来源证据

`~/.workbuddy/app/cache/experts/expert-bundle-map.json`：

```text
ex_QvM298ih8T8g -> rea-reverse-engineer
ex_ps4s7tycOR2g -> senior-fullstack-engineer
ex_zYK6DThTcjqH -> ai-agent-engineer
```

这三个 `ex_` ID 都能被在线市场的 `get-by-ids` 返回；429 条快照里三个都不存在。因此它们是**从在线市场安装的**，不是自定义专家。

---

## 4. 代码修正

### 4.1 新增在线市场客户端

`lib/portal.js`：

- `listExperts({query,page,pageSize,categories,expertType})`
- `marketSize()`：无关键词查一次 `page_size=1`，读全局 `total_count`，缓存 10 分钟
- `categories()`
- `getExpert(idOrSlug)`：`ex_` 走 `get-by-ids`，slug 先搜索再精确匹配
- `downloadInfo(id)`：返回签名 URL，识别 ZIP
- 鉴权：只从 connector / DSH 凭据解析，`Authorization: Bearer`，逐跳校验 host，401/403 直接报 `WORKBUDDY_HELPER_MARKET_AUTH_REQUIRED`

`normalizePortalExpert()` 把在线市场字段映射成统一结构：

```text
expert_id       -> id / marketExpertId
plugin_name     -> plugin
agent_name      -> agentName
display_name_zh -> displayName
profession_zh   -> profession
plugin_version  -> version
icon            -> avatar
categories      -> categories / categoryId
```

### 4.2 市场路由

`lib/market.js` 现在有 `mode: auto | portal | cos`：

- `auto`：先查在线市场；失败或没有账号时读快照，并在结果里带 `source` 与 `warning`；
- `portal`：只查在线市场，失败即报错；
- `cos`：只读快照，行为与旧版一致；
- `getExpert`：在线优先，快照兜底；返回 `marketSource`、`bundleKind`；
- `resolveBundle`：在线专家走 `download-url`（ZIP），快照专家走 `<baseUrl>/bundles/<plugin>.tar.gz`。

### 4.3 解包支持 ZIP

在线市场发的是 ZIP，快照是 tar.gz。`lib/bundle.js` 现在：

- 新增 `fflate` 解 ZIP；
- ZIP 与 tar 共用白名单：只允许 `.codebuddy-plugin/`、`.workbuddy-plugin/`、`agents/`、`skills/`、`avatars/`、`license/`、`README.md`；
- 拒绝绝对路径、`..`、符号链接/硬链接、超条目数、超解压体积；
- 兼容“平铺”和“单层目录包裹”两种包结构；
- 缓存键加入版本号，避免升级后命中旧包。

### 4.4 认证默认值

- 默认 `authMode: auto`：有 connector 可用账号就用在线市场，没有就退回快照；
- `workbuddy-connector` 是严格模式：没有 token 就报错；
- connector `resolveToken()` 现在返回账号的 `auth.domain`，在线市场基址优先用它（`www.workbuddy.cn` 或 `www.workbuddy.ai`）；
- token 只发给在线市场 API；签名 CDN 下载 URL 不带 `Authorization`；
- 旧保护仍保留：显式把 connector token 配到公开快照 host 会被拒绝。

### 4.5 搜索合并

`market` 动作现在：

- 在线市场返回 `installed: true/false`，与本机安装按 plugin 去重；
- 只在本机存在、市场上没有的专家才作为 `source=local` 追加；
- 返回 `source`、`marketTotal`、`matchedTotal`、`portalAvailable`、`warning`；
- 新增 `categories` 动作。

---

## 5. 测试过程与结果

### 5.1 单元测试

```bash
npm test
```

结果：**27/27 通过**。新增覆盖：

- 在线市场字段映射；
- `PortalMarket` 的 URL、Bearer 头、请求体、`get-by-ids`、分类；
- 无账号 token 时的 `PORTAL_AUTH_REQUIRED`；
- 在线优先、快照兜底的 `source` 与 `warning`；
- ZIP 解包与 `../escape.txt` 拒绝。

### 5.2 宿主接线测试

```bash
NODE_PATH="D:/Program Files/deepseek harness/resources/app.asar/dsh/node_modules" \
ELECTRON_RUN_AS_NODE=1 "D:/Program Files/deepseek harness/DeepSeek Harness.exe" \
test/host-integration.mjs
```

输出：

```json
{
  "ok": true,
  "tool": "workbuddy_helper",
  "command": "workbuddy-helper",
  "connector": { "installed": true, "accounts": 3, "usable": 3 },
  "selectedExpert": "ai-agent-engineer",
  "selectedSkills": ["agent-craft"],
  "market": {
    "source": "portal",
    "publicTotal": 10000,
    "localTotal": 8,
    "reverseFound": true,
    "reverseInstalled": true
  },
  "reverseExpert": "REA 逆向功能分析专家",
  "cleared": true,
  "fiberDisposed": 2
}
```

覆盖：工具/命令注册、connector、在线市场搜索、按 `ex_QvM298ih8T8g` 命中逆向专家、本地已安装标记、两个专家连续切换、`off` 清理、fiber 销毁。

### 5.3 在线市场 ZIP 包真实解析

```text
expert: ex_QvM298ih8T8g
download: 131,196 字节 ZIP
plugin: rea-reverse-engineer 1.0.0
prompt: 3,094 字符
skills: rea-analysis
warnings: []
```

证明在线市场的 ZIP 包能被安全解包、读取 `plugin.json`、提示词与技能，而不是只验证了列表接口。

### 5.4 真实 DSH 端到端：选择一个“只在市场上”的专家

为避免只测到本地副本，选择本机没有安装的 `ex_tqxz6GGmspUV`（软件逆向专家，plugin `reverse-engineer`）：

```bash
DSH_TEST_PROFILE=workbuddy-helper-market \
DSH_TEST_EXPERT_ID=ex_tqxz6GGmspUV \
node test/fake-model-expert-e2e.mjs
```

结果：

```text
EXIT 0
STDOUT EXPERT_TOOL_OK
AFTER_TOOL_HAS_EXPERT_BLOCK true
AFTER_TOOL_HAS_EXPERT_NAME true
AFTER_TOOL_HAS_OBJECT_NAMESTRING false
```

会话 sidecar：

```json
{
  "expert": {
    "id": "ex_tqxz6GGmspUV",
    "plugin": "reverse-engineer",
    "version": "1.0.0",
    "displayName": "软件逆向专家",
    "source": "market",
    "promptChars": 2653,
    "promptTruncated": false
  },
  "skills": { "expertNames": ["rea-toolkit"] }
}
```

这同时验证了：`ex_` ID 解析、ZIP 下载、解包、提示词注入、技能 provider、会话持久化。

### 5.5 tarball 安装

```bash
npm pack
dsh --profile <profile> --from-default-profile headless --dump-config
dsh plugin --profile <profile> add /absolute/path/to/dsh-workbuddy-helper-0.2.7.tgz
```

结果：安装成功，`--dump-config` 退出码 0，组合中出现：

```yaml
- id: workbuddy-helper
  name: dsh-workbuddy-helper
  config:
    enabled: true
    marketMode: auto
    authMode: auto
```

### 5.6 GitHub 安装后的在线市场验证

```bash
dsh plugin --profile workbuddy-helper-gh add \
  git+ssh://git@github.com/awswt/dsh-workbuddy-helper.git
dsh --profile workbuddy-helper-gh --dump-config | grep -A 6 workbuddy-helper
```

组合为：

```yaml
- id: workbuddy-helper
  name: dsh-workbuddy-helper
  config:
    enabled: true
    marketMode: auto
    authMode: auto
    portalBaseUrl: https://www.workbuddy.cn
```

在同一 profile 上跑假模型市场调用：

```text
EXIT 0
STDOUT: GITHUB_MARKET_OK
tool_result:
  "source": "portal"
  "marketTotal": 10000
  "matchedTotal": 5
  "items[0].id": "ex_QvM298ih8T8g"
  "items[0].profession": "软件逆向分析工程师"
  "items[0].installed": true
```

说明 GitHub 仓库里的最新代码可直接安装并访问在线市场，不依赖本地工作区。

### 5.7 真实模型

未执行：headless profile 没有 `DEEPSEEK_API_KEY`。工具管线、提示段、技能目录用本地 Messages 兼容假模型验证，不消耗真实额度。

### 5.13 陈旧路由导致专家切换失效（v0.4.9）

用户更新后仍见 `cannot get required service "agents" in inactive context` 且专家点「使用」无响应。定位：旧版本注册的 webServer 路由残留在运行中的进程，新的 client 命中了绑定在已销毁 ctx 上的旧 handler。

v0.4.6 的 disposer 只保护**之后**的热更新；对进程里已经存在的旧路由，v0.4.9 在注册前按 `/dsh-workbuddy-helper` 前缀从 `webServer.exact` 直接剔除陈旧条目（不动其他插件路由），并保留双 disposer。另修复选择专家后胶囊不刷新的 UI 问题。

验证：28/28 单测（含陈旧路由自愈用例）；Web profile 切换专家 `SELECT_RESP 200`、`BANNER none`、`PILL 会话辅助 卖得好`。注意：用户当前进程需要**完整重启 DSH 一次**才会加载到新代码；之后热更新不会再残留。



按 dsh-armory README 的连接器市场契约（316+ 个官方连接器、可装性/真实连接态、401 就地重新授权、不代填 token）改造本插件的连接器页：

- 客户端 `inject` 增加 `remote`，按需解析 `remote.mcpManager`（插件加载顺序不固定，不能只在 apply 时取一次）。
- 目录：`wbConnectorCatalog()` + `wbInstallState()` → 卡片网格（图标/名称/厂商/描述/传输/认证/标签/状态）、全部/已安装/可安装/仅展示筛选、搜索、详情。
- 操作：`wbConnectorInstall()`；返回 `needsAuth` 时走 `wbOAuthBegin()` → `wbOAuthOpen()` 打开浏览器 → `wbOAuthPoll()` 轮询 → 成功后自动重装；取消走 `wbOAuthCancel()`。需要手工令牌的连接器显示说明，绝不代填或猜测地址。
- 未安装 dsh-armory 时保留 WorkBuddy 市场 + 复制 ID 回退；本地连接器插件的会话级工具门控不变。

验证（web3 profile 安装 dsh-armory + 0.4.8）：`CARDS 632`（军械库全量目录）、`FILTERS 全部|已安装|可安装|仅展示`、首卡字段含 streamable-http/server-side/技能数/可见范围、`DETAIL_VISIBLE 1`、`ERRORS none`；`npm test` 27/27。



用户更新后反馈：面板常驻 `cannot get required service "agents" in inactive context`、专家切换无响应、技能市场仍返回 404。

根因不是 API 或 404 本身，而是 `webServer.register()` 返回的 disposer 被丢弃：插件热更新时旧 fiber 被销毁，但共享 webServer 上的旧路由仍在；浏览器拿到的是新 client bundle，命中的却是旧 handler（旧会话管理器的 `ctx.agents` 已失效 → 报错；旧路由表没有 skill-market → 404）。

修复：

1. 路由注册全部收集 disposer；作用域与插件根 ctx 双重 effect 在销毁时释放。
2. 重新注册前先释放上一轮路由，避免 duplicate 异常。
3. 移除 `ctx.get('agents')` 的“保险扫描”，会话管理器对 `agents` 的读取加防御性封装。
4. 连接器市场条目由“了解 → GitHub”改为“复制 ID”，并显示 `is_connected`。

验证：`npm test` 27/27（新增路由生命周期测试：二次注册不残留、卸载后路由表清空）；Web profile 冷启动 UI 冒烟无错误，热更新后 `/connectors` 与 `/skill-market` 仍返回 workbuddy 数据源。



按用户反馈修复四项：

1. **版本显示**：插件卡显示的是「已安装版本」，git 安装的更新按钮目标显示 commit 是宿主侧行为；本仓库已发布 `v0.4.x` git tag 与 CHANGELOG.md，更新后会显示语义化版本（实测：更新到 0.4.5 后卡片显示 v0.4.5）。
2. **连接器搜索失效**：搜索框只接了目录查询，本机连接器列表没过滤；现在本机列表也按同一关键词过滤（客户端侧），目录走 WorkBuddy 市场搜索。
3. **技能搜索逻辑**：技能页改为「本机技能优先、技能市场其次」，专家自带技能仅在无搜索词时展示、不参与搜索。
4. **按钮更名与市场数据**：胶囊按钮/面板标题改为「会话辅助」；连接器市场改从 WorkBuddy 开放平台拉取。

接口（均带 WorkBuddy 连接器账号池的 Bearer）：

```text
POST https://www.workbuddy.cn/portal/operation-platform/market/skill/list
     {page, page_size, keyword?} → data.skills[] / total_count
POST https://www.workbuddy.cn/api/v2/open-platform/buddy/connector/list
     {platform: 'desktop', page, page_size} → data.list[] / has_more
POST https://www.workbuddy.cn/api/v2/open-platform/buddy/connector/search
     {platform, keyword, page, page_size}
```

过程中修掉的真实问题：

1. `resolveAuth` 会把请求基址改写成账号令牌的域（www.codebuddy.cn），触发 URL 允许列表拒绝（`host is not allowed: www.codebuddy.cn`）；市场端点统一落在 www.workbuddy.cn，移除域覆盖。
2. 客户端 `ROUTES.skillMarket` 常量漏加，面板内技能市场始终 404（API 直连正常）。

Playwright 验证（0.4.5，Web profile + dsh-windows-mcp）：

```text
PILL_TEXT 会话辅助 REA 逆向功能分析专家
TABS 专家1 | 技能4 | 连接器
连接器市场头：WorkBuddy 连接器市场 · 第 1 页（首条 通达信）
PLUGIN_FILTERED 1（搜 win）
CATALOG_ROWS 4（搜 github，首条 GitHub）
SKILL_SECTIONS 本机技能 | 技能市场
MARKET_ROWS 12（搜 浏览器，首条 Web Access（浏览器自动化）v2.5.4）
ERRORS none
```



在 5.8 的基础上按用户新需求完成三项：

**1. 连接器页签**。宿主新增 `lib/connectors.js`：

- 扫描 profile `node_modules` 里的连接器类插件（名称含 `connect/mcp/ima/browser`、或描述含“连接器/MCP”、或 `dsh.connector: true`）；
- 从插件源码提取工具名前缀（`mcp__<server>__` 与重复出现的 `<seg>_`），把 `ctx.tools.definitions()` 里的工具映射回所属连接器；
- 每个会话维护停用集合，通过 `agent.ctx.tools.restrict({ deny })` 生效，`agent/created`、`agent/disposed`、`tools/change`、`agent/pre-step` 都会重算（带重入保护，参照 dsh-windows-mcp 的实现）；
- 下方是 MCP 连接器目录（`mcp_connector.json` 的 133 个目录项），支持搜索与分类。

**2. 技能搜索**。技能页顶部搜索框，按名称+描述过滤两个分区，空态文案区分“无技能”与“无匹配”。

**3. 深色模式修复**。探查发现 DSH 的 `--dsw-alias-brand-primary` 在浅色是 `#0f1115`（近黑）、深色是白：主按钮“品牌底+白字”在深色变成“白底白字”。改为单色反色：`background: var(--dsw-alias-label-primary)`、`color: var(--dsw-alias-bg-layer-2)`，两个主题都可读。

Playwright 验证（Web profile，dsh-windows-mcp 已装作真实连接器）：

```text
TABS 专家1 | 技能5 | 连接器
SKILL_MATCH_ROWS 6（搜索 “rea” 命中 rea-analysis 与 research-* 等）
SAVE_COLORS_DARK {"bg":"rgb(255, 255, 255)","color":"rgb(23, 24, 28)","text":"保存技能"}
POST /connectors/session 200 {"disabled":["dsh-windows-mcp"]}
CATALOG total=133，搜索“地图” → 5 条（高德地图、百度地图…）
ERRORS none
```

过程中修复的三个真实问题：

1. `connectorViews()` 原是同步，路由层 `.catch()` 抛错；改为 async 并在 `Promise.resolve().then()` 里调用。
2. 插件经 pnpm 装载时 `import.meta.url` 指向 `.pnpm` 真实路径，向上三级找不到 profile；改为先按 `--profile` argv、再按 `$DSH_HOME/profiles` 向上定位。
3. pnpm 的依赖是 junction/symlink，`readdir(withFileTypes)` 需接受 `isSymbolicLink()`；另外 `existsSync` 不能从 `fs.promises` 取。


插件现在带客户端半区：`conversation.input.left` 槽位一个「专家」按钮，点击打开同源面板。
宿主半区注册 5 条 JSON 路由：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/dsh-workbuddy-helper/state` | GET | 当前专家、技能、分类、市场规模、connector |
| `/dsh-workbuddy-helper/experts` | GET | 在线市场 + 本地专家，支持 `query/categoryId/page` |
| `/dsh-workbuddy-helper/select` | POST | 切换专家 |
| `/dsh-workbuddy-helper/skills` | POST | 保存技能开关 |
| `/dsh-workbuddy-helper/off` | POST | 移除专家 |

在 Web profile 上启动 `dsh --no-open --port 3131`，用 Playwright（`channel: msedge`）执行：

```text
PILL_COUNT 1
PANEL_COUNT 1
EXPERT_ROWS 24
CATEGORY_ROWS 14
REA_ALREADY_ACTIVE（第二次运行时）
SAVE_STATUS 当前：REA 逆向功能分析专家 · 已生效
PILL_TEXT_AFTER 专家 REA 逆向功能分析专家
ERRORS none
```

搜索 `软件逆向` 时，市场返回 5 条，第一条是 `ex_QvM298ih8T8g`，点击「使用」后：

```json
{
  "expert": { "id": "ex_QvM298ih8T8g", "displayName": "REA 逆向功能分析专家" },
  "applied": true,
  "expertSkills": ["rea-analysis"]
}
```

截图：

- `docs/ui-2-panel.png`：专家面板与分类
- `docs/ui-3-search.png`：搜索“软件逆向”
- `docs/ui-5-skills.png`：技能开关
- `docs/ui-7-composer.png`：输入区按钮显示当前专家

过程中修复的两个真实问题：

1. `webServer.register` 被解构后丢失 `this`，路由注册抛 `Cannot read properties of undefined (reading 'exact')`；改为 `bind(webServer)`。
2. 客户端 `apiUrl()` 只返回 `pathname`，丢掉了 `?sessionId=` 与搜索参数，导致状态接口 400；改为返回 `pathname + search`。

---

## 6. 安装方式

### 6.1 当前可用（不依赖 GitHub）

```bash
npm pack
dsh plugin --profile <profile> add /absolute/path/to/dsh-workbuddy-helper-0.2.7.tgz
```

或放到 HTTPS 静态地址：

```bash
dsh plugin --profile <profile> add https://your-cdn.example.com/dsh-workbuddy-helper-0.2.7.tgz
```

### 6.2 npm 标准方式（发布后可用）

```bash
dsh plugin --profile <profile> add dsh-workbuddy-helper
```

当前本机 `npm whoami` 返回 `ENEEDAUTH`，包未发布，所以这条命令现在还不能用。维护者执行：

```bash
npm login
npm publish
```

### 6.3 GitHub 方式（仅开发）

```bash
dsh plugin --profile <profile> add git+ssh://git@github.com/awswt/dsh-workbuddy-helper.git
```

需要 GitHub SSH、Git、pnpm Git 构建链，装的是源码而非版本化产物，只适合开发者。

---

## 7. 限制

1. 在线市场 `total_count` 恰为 `10000`，可能是平台上限而非绝对真实条数；第 101 页为空，可检索范围就是这 1 万条。
2. 在线市场需要账号；没有账号时插件退回 429 条快照，并在结果里标注 `source=cos` 与 `warning`。
3. 截图中 2 张卡片未精确命中名称，可能是账号/企业范围或显示名差异；其余 7 张可对应。
4. 没有 Web UI，仍是工具 + 斜杠命令形态。
5. 真实模型人格服从度未测。
6. npm 包未发布。

---

## 8. 关键文件

```text
lib/portal.js          # 新增：在线市场
lib/market.js          # 在线优先 + 快照兜底
lib/bundle.js          # ZIP + tar.gz 安全解包
lib/auth.js            # auto 模式、domain 推导
lib/connector.js       # resolveToken 返回 domain
lib/index.js           # market/categories 动作、合并去重、Web UI 接线
lib/client.js          # 输入区「专家」按钮 + 面板
lib/webui.js           # 同源 JSON 路由
lib/session.js         # slug 优先本地、ex_ 走市场
test/core.test.mjs     # 13 项核心单测
test/webui.test.mjs    # 5 项面板路由单测
test/connectors.test.mjs # 4 项连接器单测（扫描/映射/门控/品牌色）
test/portal-market.test.mjs # 4 项市场接口单测（skill/list、connector list/search、面板路由）
test/host-integration.mjs
cordis.patch.yml       # marketMode/authMode/portalBaseUrl 默认值
```

---

## 9. 仓库状态

```text
git@github.com:awswt/dsh-workbuddy-helper.git
main
0db88a7 feat: add connectors tab, skills search and dark-mode safe primary button
2c84660 feat: add composer expert picker and skills panel
54abc51 feat: read the live WorkBuddy expert market with snapshot fallback
```

安装包：`dist/dsh-workbuddy-helper-0.2.7.tgz`（本地产物，68 KB，未提交）。

在线市场 `54abc51`、输入区面板 `2c84660`、连接器/技能搜索/深色修复 `0db88a7`；本报告的后续文档提交在其之后。
