# WorkBuddy 连接器管理逆向结论

本文是 `lib/connectors.js`、`lib/connector-flow.js`、`lib/mcp-patch.js` 三个模块的设计依据。
凡是"照搬 WorkBuddy"的地方，都能在下面找到对应的证据位置；凡是没照搬的地方，都写了不照搬的原因。

## 1. 分析与证据

| 项 | 值 |
|---|---|
| 样本 | `E:\DSH\workspace\migrate\WorkBuddy.exe`（441,094,104 字节，PE32 NSIS 安装器） |
| 内层载荷 | `$PLUGINSDIR\app-64.7z`（440,177,782 字节） |
| 应用归档 | `resources/app.asar`（96,544,269 字节） |
| 归档 SHA-256 | `3e50fcb5b060deba4f1ea9a8c293cf955bf12d7e52d971985de914350afd9077` |
| REA 清点 | `node_count=8921`、`occurrence_count=17353`、`edge_count=12941`、`integrity_contradictions=0` |
| REA 证据 | `ev_e25bf8f6761b1d420dba27175bb26ed8007efc605df72587042fcd532426b83e`（清点全集）、`ev_1a9de3d7868459edaa7d820156fedd7cb9daa453e8756cd9286595712ccb0fc4`（路径级清单） |

关键条目（REA 路径级清单实测，`entry_kind=file`）：

| 逻辑路径 | 声明大小 | 状态 |
|---|---|---|
| `main/server.js` | 3,600,054 | 归档内 |
| `renderer/assets/connector-capsule-0_jkKscK.js` | 26,229 | `unpacked: true` |
| `renderer/assets/store-BR9eZ-QX.js` | 64,069 | `unpacked: true` |

取证工具链（都留在 `.workbuddy/reverse/`，可复跑）：

```powershell
# 1) NSIS 安装器 → 内层 7z → app.asar（Bandizip 列/取，bsdtar 解 7z）
& 'C:\Program Files\Bandizip\bz.exe' l WorkBuddy.exe
& 'C:\Program Files\Bandizip\bz.exe' e WorkBuddy.exe '$PLUGINSDIR\app-64.7z'
tar -xf app-64.7z -C .workbuddy\reverse\asar resources\app.asar
tar -xf app-64.7z -C .workbuddy\reverse\unpacked resources\app.asar.unpacked\renderer\* resources\app.asar.unpacked\main\*

# 2) asar 头解析（REA 的 extract_artifact 对 unpacked companion 会拒，故自写）
node .workbuddy\reverse\asar-list.mjs .workbuddy\reverse\asar\resources\app.asar "connector"
node .workbuddy\reverse\asar-extract.mjs .workbuddy\reverse\asar\resources\app.asar .workbuddy\reverse\core "main/(server|index|esm2|acp)\.js"

# 3) 在 3.6MB 单行 bundle 里定位命中点并切片/美化
node .workbuddy\reverse\snippet.mjs .workbuddy\reverse\core "createConnectorService" 400
node .workbuddy\reverse\slice.mjs .workbuddy\reverse\core\main\server.js 1811593 1824000 out\connector-facade.txt
node .workbuddy\reverse\pretty.mjs out\connector-facade.txt out\connector-facade.pretty.js
```

asar 头格式实测（容易踩坑）：JSON 起始在偏移 16，其前 4 字节是 headerSize，
`baseOffset = 16 + ceil(headerSize / 4) * 4`。pickle 头不是标准的"8 字节 + 两个 int"，
按标准 pickle 解析会直接读错。

## 2. WorkBuddy 连接器的三层结构

```
renderer (zustand store)
  mcpConnectorConfigs   目录/配置      ← connectorGetConfigs
  mcpConnectorStates    运行时状态      ← connectorGetStates
        │  connectConnector / disconnect / repair / cancel
        ▼
preload IPC 面（main/server.js registerConnectorsHandlers）
  connectorInit / GetConfigs / GetStates / Connect / RepairConnect /
  Disconnect / CancelConnect / UpdateHeaders / UpdateEnv / Unbind /
  SetIndustryBuddyScope / RESOLVE_POI_CONSENT
        │
        ▼
createConnectorService({ connectorService, mcpManager, logger })   ← 门面，真正的控制流
  connectorService.getConfigs() / prepareMcpConnect / connect / cancelConnect
  mcpManager.getAuthMode / connect / cancelAuthorization / onDidChange
```

事件桥 `registerConnectorEventBridge` 往外推 `UNAUTHORIZED`、`UNBOUND`、`AUTH_QR_URL`、
`DEVICE_CODE`、`IDENTITY_CHANGED`、`MARKET_DOWNLOAD_PROGRESS`——注意这是"服务端主动推"，
不是靠界面轮询。

## 3. 数据模型（渲染层实测）

配置（`toConnectorConfigInfo`）：

```js
{ id, name: displayName, description, icon, visibleIn, authMode, versionIncompatibility, skills: [], examples }
```

状态（`toConnectorStateInfoMap`，源记录是 `{connectorId, bound, enabled, status, reason:{code,message}, tools}`）：

```js
{ configId, bound, enabled, connected: status === 'connected', connecting: status === 'connecting',
  pending: status === 'connecting', reason, tools }
```

判定函数拆得很细，值得我们照抄的是它的"不要用一个 boolean 表达多义状态"：

| 函数 | 语义 |
|---|---|
| `isConnectorBound` | 已经绑定过凭据 |
| `isConnectorEnabled` | 用户开关是开的 |
| `isConnectorConnected` | 运行时真的连上了 |
| `isConnectorPending` | 正在连（可取消） |
| `connectorNeedsAuthorize` | `reason.code` 归一后等于 `authorize` |

显示状态 `getMcpDisplayStatus`：有 `reason` → `unauthorized` / `error`；否则 `connected` → connected；其余 disconnected。

错误分类 `getConnectorErrorDisplayKind` 输出五种：`authorize | configure | upgrade | contact-admin | retry`。

连接结果联合类型（`isConnectSuccess` 还额外接受 `accepted`）：

```js
{ status: 'connected' | 'connecting' | 'cancelled' | 'action-required',
  state, action: { kind: 'form' | 'open_url', ... }, requestId }
```

## 4. 连接流程（门面内的真实分支）

`createConnectorService` 的核心不是"调一个 connect"，而是**单飞 + 逐阶段让位校验**：

1. `mcpId = id => \`connector:${id}\``；`activeOperations: Map<configId, opId>`，`opId = ${configId}#${++sequence}`。
2. 同一 `configId` 已有动作 → 立刻返回 `{success:false, connecting:true}`（不排队、不并发）。
3. 每个异步阶段结束都跑 `isCurrent()`；被别人取代则返回 `{success:false, cancelled:true}`，
   避免旧回调把新状态改回去。
4. 按类型分流：
   - `type === 'cli' | 'skill-only'` → `connectorService.connect(...)`，不涉及 MCP。
   - 其余 → `prepareMcpConnect({ allowAuthorization, userInitiated, onAuthorizeUrl, reauthorize })`。
5. `mcpManager.getAuthMode(mcpId) === 'oauth'` 时：
   - `resolveMcpDependency` 得到 `dep.state ∈ {ready, unauthorized, error}` + `hasRecoverableCredentials`；
   - 非 unauthorized 先试 `mcpManager.connect()`，成功即 `completeMcpConnect`；
   - 仍 unauthorized 或本次是 repair → `beginAuthorization`（串行队列）→ 返回
     `{success:false, needsAuth:true, authStart:{nextAction:'redirect', authorizeUrl, expireAt}}`。
6. 非 OAuth → `startProbe()`（异步 connect）并**立即**返回 `{success:false, connecting:true}`；
   probe 结束再 `completeMcpConnect` / `failMcpConnect(reasonCode:'auth-failed')`。
7. `describeConnectorResult` 归一：`success→success`、`cancelled→cancelled`、
   `needsTokenConfig→needs-token-config`、`needsAuth→needs-auth`、其余 `failed`。
8. `settlePending`：`mcpManager.onDidChange` / `onDidOAuthReconnectSettled` 回调把 pending 的
   连接结算（ready→complete，unauthorized/error→fail），并且**忽略 stale authorizationId**。
9. `unbind` 先 revoke 远端凭据，失败就直接报错（"服务端授权未注销，请重试解绑"），不留半解绑状态。

目录网关（`createConnectorCatalogGateway(facade, transport)`）有两条通道：
`transport === 'cloud'` 走 `facade.list()`；否则 `facade.listMarket({start, limit, includeStateful})`；
实例按 transport 在 `WeakMap` 里缓存。`fetchInputConnectorCatalog` 固定用 `listPage(0, 50, {includeStateful:true})`。

## 5. 映射到本插件（照搬了什么、改了什么）

| WorkBuddy 概念 | 本插件实现 | 差异与原因 |
|---|---|---|
| `connectorGetConfigs` / `connectorGetStates` | `connectors.configs()` / `connectors.states(sessionId)` / `stateOf()` | DSH 里状态必须带会话维度，否则"某会话停用"和"全局已连接"会互相污染 |
| `activeOperations` 单飞 + `${id}#${seq}` | `lib/connector-flow.js` 的 `createOperationRegistry().claim()` | 完全照搬，包含 `granted:false, current:opId` 的返回形状 |
| `isCurrent()` 逐阶段校验 | `registry.isCurrent(configId, opId)` | 照搬 |
| `describeConnectorResult` 五分类 | `normalizeConnectResult()` → `connected/connecting/cancelled/action-required/failed` | 照搬语义，字段名对齐渲染层联合类型 |
| `getConnectorErrorDisplayKind` | `describeConnectorError().kind` | 照搬五种：authorize/configure/upgrade/contact-admin/retry |
| token 表单（`action.kind='form'`） | `tokenConfigAction()` | 照搬；额外强调"已有凭据只标记 `present`，永不回显真实值" |
| OAuth 跳转（`needsAuth` + `authStart.authorizeUrl`） | `oauthHandoffAction()` → 跳 `/mcp-connector/ui` | DSH 侧授权页由 `dsh-mcp-connector` 提供，不自己实现 OAuth |
| `mcpManager.connect()` 异步 probe | `connect()` 里轮询 `tools.definitions()`（`probeTimeoutMs` 8000 / `probeIntervalMs` 250） | DSH 没有"连接成功"回调，唯一可靠信号是工具是否注册出来 |
| `connectorService.prepareMcpConnect` + patch 落地 | `lib/mcp-patch.js` 写 `cordis.patch.yml` 的 `insert` 条目 | 宿主已有 `@deepseek-ai/dsh-mcp-client`，复用它而不是自建 MCP 客户端 |
| `repairConnector` / `cancelConnector` / `disconnect` / `unbind` / `updateHeaders` / `updateEnv` | 同名方法一条不缺 | 少一个就会让用户卡在中间态 |
| 事件桥主动推状态 | `onStateChange(fn)` + `/connectors/state` 轮询 | 插件侧没有 WorkBuddy 那样的常驻 IPC 通道 |

### 没有照搬的部分

1. **不 import `dsh-mcp-connector` 的内部模块**。它在 `lib/*.js` 里一次 `ctx.provide(` 都没有，
   没有对外服务面；直接 import 会拿到一堆依赖宿主注入的私有状态，升级即碎。
   它暴露的只有 Web 端点 `/mcp-connector/api`、`/mcp-connector/events`、`/mcp-connector/ui`，
   所以本插件只在 OAuth 场景把用户**送去**那个 UI。
2. **不自建 OAuth 客户端**。WorkBuddy 有自己的 `beginAuthorization` 串行队列和 PKCE 实现；
   DSH 侧复用 `dsh-mcp-connector` 的授权页，避免两套 token 生命周期。
3. **不假装"连接完成"**。patch 写入后宿主必须重启才会挂载 MCP server，所以状态显式标
   `reason.code = 'restart-required'`，返回 `connecting` 而不是 `connected`。
   WorkBuddy 能立即 connected 是因为 MCP server 跑在它自己的进程里；DSH 不是。

## 6. 会话门控为什么用 `tools.restrict({ deny })`

`lib/connectors.js` 的原有关闭开关走 `agent.ctx.get('tools').restrict({ deny })`，
与 `dsh-windows-mcp` 的 Computer Use 开关同一机制。理由：

- 它是 DSH 公开 API 里唯一"只收窄某个 agent 的工具视图、不动全局注册"的能力；
- 作用域天然按会话（每个 agent 一份 scoped tools）；
- `agent/disposed` 时释放，不需要额外清理。

连接器状态的会话维度就建立在这上面：全局 `bound/enabled` 记在 `<dataDir>/connectors.json`，
会话维度的"本会话停用"记在同文件的 `sessions` 段，并在每个 `agent/created`、`agent/pre-step` 重新施加。

## 7. 已知局限

| 局限 | 影响 | 现状 |
|---|---|---|
| 目录只读 `storages/mcp_connector.json` 的 `catalog.remote` | 本机没有已连接连接器时 `connections` 表为空，无法展示"已连接"来自目录之外的记录 | 以 `connectors.json` 自己的 `bound` 为准，两者取并集 |
| MCP server 挂载需要重启 | 首次连接必须重启一次 | 状态里明示 `restart-required`，UI 显示"待重启生效" |
| 目录条目的 `transport` 取值未做枚举校验 | 异常的 `transport` 会原样写进 patch | `normalizeSpec` 只校验"stdio 必须有 command，非 stdio 必须有 url" |
| 没有实现 WorkBuddy 的 `setIndustryBuddyScope` | 行业助手作用域不生效 | 该能力只对 WorkBuddy 自家连接器有意义 |
