# 连接器模块改造与端到端测试报告

- 日期：2026-11-22
- 插件：`dsh-workbuddy-helper` 0.6.0（工作树）
- 目标：把 WorkBuddy.exe 的连接器管理语义搬进本插件，并在真实 DSH headless 会话里验证**专家 / 技能 / 连接器**三条链路都能进入会话
- 关联文档：[WorkBuddy 连接器逆向笔记](./workbuddy-connector-reverse-engineering.md)、[端到端基线](./e2e-baseline.md)

---

## 1. 结论

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 连接器目录读取（134 条真实 catalog） | PASS | §4.2、探针 `connectorAction=list` → `catalogTotal:134`、8 分类 |
| 连接器连接（stdio + api-key，写 patch 落地） | PASS | §4.3 探针 1/5A：`cordis.patch.yml` 生成 `mcp-amap` 条目 |
| 连接器工具进入模型工具集 | PASS | §4.4 探针 3：`tools=39`，其中 12 个 `mcp__amap__*` |
| 连接器状态反映运行时 | PASS | §4.4 `state amap` → `connected:true, toolCount:12` |
| 会话级停用真的藏掉工具 | PASS | §4.5 探针 6：`39 → 27 → 39` |
| 断开回滚 patch | PASS | §4.6 探针 7：`status:'disconnected'`、patch 条目清空、`connectedCount:0` |
| 专家进入会话 | PASS | §4.4 探针 3：`expertBlock=true`、`expert=程枢` |
| 技能进入会话 | PASS | §4.4 探针 3：`skills` 返回含专家技能的目录 |
| 单元测试 | PASS | §4.1：11 个文件、62 条、0 失败 |
| REA 逆向取证 | PASS | §5：asar 容器清点 + 已装产物静态分析（0 parse failure） |

一句话：**连接器从"能列出目录"做到了"能连上、工具进会话、能按会话隐藏、能干净断开"，并且状态不再说谎。**

---

## 2. 逆向依据：WorkBuddy 的做法 → 本插件的落点

WorkBuddy.exe（441,094,104 字节 NSIS 安装器）→ `app-64.7z` → `app.asar`（96,544,269 字节，
sha256 `3e50fcb5…afd9077`）。连接器侧有三层：渲染层 zustand store、preload 的 12 个 IPC handler、
主进程 `createConnectorService` 门面。逐条映射如下（详细逆向见另一份文档）：

| WorkBuddy 概念 | 本插件实现 | 差异与原因 |
| --- | --- | --- |
| `mcpConnectorConfigs`（目录） | `connectors.configs()` | 目录来自 `$DSH_HOME/storages/mcp_connector.json` 的 `catalog.remote.connectors`，而不是 WorkBuddy 的云端 market |
| `mcpConnectorStates`（`{configId,bound,enabled,connected,pending,reason}`） | `connectors.states()` / `stateOf()` | 字段对齐，另加 `toolCount/tools/authMode/credentialReady` |
| `getMcpDisplayStatus` | `state.reason.code`（`disabled`/`session-disabled`/`no-tools`/`unbound`/`restart-required`） | UI 判定改成后端算好，前端只渲染 |
| `getConnectorErrorDisplayKind`（authorize/configure/upgrade/contact-admin/retry） | `connector-flow.describeConnectorError()` | 同一套五种 kind |
| `connectConnector(id, opts)` | `connectors.connect(id,{action,sessionId,token,credentials,headers,env})` | 单飞、幂等、可取消 |
| 单飞 `activeOperations: Map<configId, opId>` + `isCurrent()` | `connector-flow.createOperationRegistry()`（opId=`${id}#${seq}`） | 语义一致：重复点击返回 `{success:false,connecting:true}`，过期操作让位 |
| `describeConnectorResult`（success/cancelled/needs-token-config/needs-auth/failed） | `normalizeConnectResult()`（connected/disconnected/connecting/cancelled/action-required/failed） | 多出 `disconnected`：断开是独立终态，之前借用 `success` 会让 UI 显示"已连接" |
| `repairConnector` / `cancelMcpConnector` / `unbind` | `repairConnect` / `cancelConnect` / `unbind` | `unbind` 先清凭据再断开 |
| `listMarket` / `listPage` / `lookup`（catalog gateway） | `connectors.gateway()` 的 `list/listPage/search/lookup` | 单一数据源，不需要 cloud/local 双通道 |
| `prepareMcpConnect` → 起 MCP → 轮询工具 | `connect()` → 写 patch → `waitForTools()` 轮询 → 判定 | 本插件不自建 MCP 客户端，交给宿主 `@deepseek-ai/dsh-mcp-client` |
| `oauth2-pkce` 走 `beginAuthorization` 拿 `authorizeUrl` | `oauthHandoffAction()` 交接到 `dsh-mcp-connector` 的 `/mcp-connector/ui` | 不自研 OAuth：`dsh-mcp-connector` 已实现且**不导出 ctx 服务**，只能交接 |

三条"故意不照搬"的决定：

1. **不自建 MCP 客户端。** 宿主已有 `@deepseek-ai/dsh-mcp-client`，重写传输与重连是负资产。本插件只往 profile 的 `cordis.patch.yml` 写 `insert` 条目，重启后由宿主挂载。
2. **不自研 OAuth。** `dsh-mcp-connector` 0.2.119 的授权流程完整（PKCE + 回调服务器 + grant journal），但它不 `ctx.provide()` 任何服务，无法当库复用，因此 oauth 类连接器直接交接给它自己的 UI。
3. **不假装"连上就是连上"。** patch 写入后需要重启才挂载，所以状态显式标 `restart-required`，并在 UI 文案里说"已写入启动补丁，重启 DSH 后生效"。

---

## 3. 代码变更

| 文件 | 变化 | 说明 |
| --- | --- | --- |
| `lib/mcp-patch.js` | **新增**（约 330 行） | vendored armory 的 patch 约定：`readMcpServers`/`upsertMcpServers`/`setMcpDisabled`/`removeMcpServer`；保留用户注释；空 patch 强制写成 block 风格 |
| `lib/connector-flow.js` | **新增** | 单飞注册表、结果归一、错误归类、凭据字段推导（`credentialFieldsOf`/`credentialsSatisfied`/`credentialsRequired`）、token 表单与 OAuth 交接 action |
| `lib/connectors.js` | **重写**（376 → ~950 行） | 目录 + 状态 + 连接/修复/取消/断开/解绑/改 env/改 headers/启停 + 目录网关 + 串行化门控 |
| `lib/webui.js` | 新增两个路由 | `GET /connectors/state`、`POST /connectors/action`（`sameOrigin` 校验，未知 action 400） |
| `lib/index.js` | 工具与命令接线 | `workbuddy_helper` 增 `connectorAction`/`connectorId`/`token`；命令 `connector <sub> <id>`；`connectors.init()` |
| `lib/client.js` | UI 接线 | 行内凭据输入框、连接/断开按钮、状态徽标、`connectorResultText` 文案 |
| `test/*.test.mjs` | 新增 5 个文件 | `mcp-patch` / `connector-flow` / `connector-controller` / `connector-real-shapes` / `connector-tool-enumeration` / `connector-gate` |

---

## 4. 验证

### 4.1 单元测试

命令：`node --test test/*.test.mjs`，结果 **62 tests / 62 pass / 0 fail**。

| 文件 | 条数 | 覆盖 |
| --- | --- | --- |
| `mcp-patch.test.mjs` | 9 | patch 读写、同名原位更新、`disabled` 开关、删除幂等、重复 serverName 报错、空 patch 变 block 风格 |
| `connector-flow.test.mjs` | 6 | 单飞 claim/release/cancel、结果归一六分支、错误归类五种 kind、表单字段生成 |
| `connector-controller.test.mjs` | 8 | 目录+插件合并、api-key 缺 token 不写 patch、带 token 写 headers、oauth 交接、断开清条目、并发第二次返回 connecting、未知 id |
| `connector-real-shapes.test.mjs` | 5 | 真实目录的三种 `servers[0]` 形状：stdio + `credentialBindings`、`headerCredentialBindings`、多凭据字段、残缺条目 |
| `connector-tool-enumeration.test.mjs` | 3 | 宿主只有 `schemas()` 时也能数出工具、无名条目忽略、两者都没有时不崩 |
| `connector-gate.test.mjs` | 3 | `init()` 注册四个钩子、停用后 pre-step 用 agent 作用域 restrict、门控异常不阻断 next() |
| `connectors.test.mjs` | 4 | 旧 API 回归（插件扫描、工具前缀、会话门控） |
| `core.test.mjs` / `portal-market.test.mjs` / `route-lifecycle.test.mjs` / `webui.test.mjs` | 13 / 4 / 2 / 5 | 既有能力回归 |

### 4.2 真实目录冒烟（不碰线上 profile）

脚本：`.workbuddy/tmp/real-catalog-smoke.mjs`（读真实 `mcp_connector.json` + 临时 patch/dataDir）。

- `total=134`；认证分布 `none=50 / api-key=37 / bearer=28 / oauth-pkce=19`
- 分类 8 个：其他、办公协作、开发工具、效率工具、法律合规、设计创意、调研分析、金融投资
- `gateway.listPage/search('amap')/lookup` 正常；api-key 表单字段 = 目录声明的 `apiKey`
- 落地 patch（stdio 连接器把凭据注入 env，而不是 headers）：

```yaml
- insert:
    - id: mcp-amap
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: amap
        transport: stdio
        command: npx
        args: [ -y, "@amap/amap-maps-mcp-server" ]
        env:
          AMAP_MAPS_API_KEY: smoke-token-123
```

### 4.3 端到端环境

- 隔离 home：`E:\DSH\workspace\migrate\.workbuddy\probe\dshhome`（不动 `C:\Users\Administrator\.dsh`）
- profile：`wbhelper-work`，`dsh.profile.bundles` = `['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless','dsh-workbuddy-helper']`，`patchReload: 'live'`
- 安装：`dsh plugin --profile wbhelper-work add file:…/pack-v5/dsh-workbuddy-helper-0.6.0.tgz` → `Packages: +9`
- 假模型：OpenAI Chat Completions 方言，SSE，记录每个请求体的 `tools`/`messages`
- 驱动脚本：`.workbuddy/probe/probe-multi.mjs`（链式调用工具，最后打印 `PROBE*_OK`）

### 4.4 探针 3：连接器工具 + 专家 + 技能同场

`EXIT 0 in 4992ms; requests=7`

| 请求 | tools | 观察 |
| --- | --- | --- |
| req0（首轮） | 39 | `workbuddy_helper` schema 含 `action|expertId|connectorAction|connectorId|token|…` |
| req2 | 39 | `state amap` → `{bound:true, connected:true, reason:null, toolCount:12}`，`tools` 前缀 `mcp__amap__` |
| req3 | 39 | `list` → `catalogTotal:134`、`connectedCount:1` |
| req5 | 39 | `expertBlock=true`、`expert=程枢`（`applied:true`，plugin `ai-agent-engineer@1.0.0`） |
| req6 | 39 | `skills` → `globalMode:'all'`，专家技能 `agent-craft` 出现在目录中 |

stderr 里出现 `Amap Maps MCP Server running on stdio`——连接器是被宿主真实拉起的进程。

### 4.5 探针 6：会话级停用真的生效

| 请求 | tools | 说明 |
| --- | --- | --- |
| req0 | 39 | 连接器在线 |
| req2 | 39 | 第 1 步（state）执行完 |
| req3 | **27** | `disable amap` 生效：12 个 `mcp__amap__*` 从工具表消失 |
| req4 | 27 | `state` 返回 `reason:{code:'disabled'}` |
| req5 | **39** | `enable amap` 恢复 |
| req6 | 39 | 再次确认恢复 |

### 4.6 探针 7：断开

- `disconnect amap` → `{status:'disconnected', success:true, state:{bound:false, connected:false}}`
- 随后 `state` → `reason:{code:'unbound'}`、`toolCount:0`
- `list` → `connectedCount:0`
- `cordis.patch.yml` 里 `mcp-amap` 条目被清空

### 4.7 REA 取证

| 操作 | 结果 |
| --- | --- |
| `open_binary` + `inspect_artifact`（`app.asar`） | 39,215 条目全量清点，`node_count=8921`、`occurrence_count=17353`、`integrity_contradictions=0`，evidence `ev_e25bf8f6…` |
| `inspect_analysis_view`（inventory/occurrences） | 三条目标文件尺寸：`main/server.js`=3,600,054；`connector-capsule-…js`=26,229；`store-BR9eZ-QX.js`=64,069（后两者 `unpacked:true`），evidence `ev_1a9de3d7…` |
| `analyze_javascript_application`（已装 0.6.0 产物） | root sha256 `95ece399…`，15 个 JS 全部解析成功 `parse_failures=0`，37,262 AST 节点，201 findings，evidence `ev_5b1888a1…` |

### 4.8 GitHub 安装基线（0.5.0 @ `c7055ae`）

改造前的"从 GitHub 装最新代码"这条路径已单独验证，详见 [e2e-baseline.md](./e2e-baseline.md)：

| 项 | 结果 |
| --- | --- |
| 新 profile 从 GitHub 安装 | PASS：`dsh-workbuddy-helper@0.5.0`，commit `c7055ae`，真 home 3.39s / 隔离 home 8.73s，`Packages: +9`，`--dump-config` 可见 `workbuddy-helper` |
| 连接器 | PASS：`workbuddy_helper` schema 随请求下发（`required=["action"]`），`action=connector` 返回真实 `connector.status()`；目录 134 条 / 8 分类 |
| 专家 | PASS：`applied=true`（`ai-agent-engineer` / 程枢 / 1.0.0），下一轮 system 10686 字符且含 `<expert_selection state="active">` |
| 技能 | PASS：`<available_skills>` 独立消息从 8 条 2425B 变为 9 条 2546B（新增 `agent-craft`） |
| 真 home 引导 | BLOCKED（环境级）：home patch 里 `preset-maoying` 依赖未安装的 `@deepseek-ai/dsh-agent-preset`，已用隔离 `DSH_HOME` 绕过 |

**注意版本差异**：GitHub 上 0.5.0 的 `connector` action 只返回 `status()`，没有目录/状态/连接能力；
本报告 §4.2–§4.6 的全部连接器结论属于工作树 0.6.0（未提交）。两者不可混用同一份证据。

### 4.9 GitHub 安装最新版（0.6.1 @ `761ec32`）—— 三市场同时进会话

改造完成并推送后，重新走一遍"从 GitHub 装"这条真实路径，覆盖本轮新增的能力（连接器管理页桥接、技能真实安装）：

```powershell
$env:DSH_HOME="E:\DSH\workspace\migrate\.workbuddy\probe\dshhome"
node "C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  plugin --profile wbhelper-gh061 add `
  "https://codeload.github.com/awswt/dsh-workbuddy-helper/tar.gz/761ec326c9d1f5c31301c528e78a198e86dd8f9f"
# Packages: +9, Done in 2.7s；装进去的 package.json version = 0.6.1
```

内容新鲜度用特征串验证（同版本号不等于同内容，见 AGENTS.md §6）：`lib/connectors.js` 命中 `readSharedConnectorState|connector-ui` 3 处、`lib/skill-install.js` 命中 `projectRootOf|integrity check` 4 处。

探针（假模型 + 真 headless 会话，`PROBE_PORT=9904 PROFILE=wbhelper-gh061`，6 步计划：connector list → skill-market → skills install → skills → expert → skills）：

| 链路 | 证据 | 判定 |
| --- | --- | --- |
| 工具下发 | `tools=27`，`workbuddy_helper` 参数含 `action/skillAction/skillId/page/pageSize/expertId/connectorAction/connectorId/token/query/mode/names/expertNames` | PASS |
| 连接器 | `catalogTotal:134`、8 分类、`connectorUi:{available:true,...}`、`accounts:{accountCount:4,usableAccountCount:4}` | PASS |
| 技能市场 | `{total:3437, source:'portal', items:[{id:'skill_2095395851789164544', slug:'docx', name:'Word 文档处理', version:'1.0.0'}]}` | PASS |
| 技能真实安装 | `{ok:true, installed:{slug:'docx', path:'E:\DSH\workspace\migrate\.dsh\skills\docx', ...}}`，5 文件 22KB | PASS |
| 技能进会话 | 下一次 `action=skills` 返回 `globalMode:'all'`，9 条技能且 `hasDocx:true`（`agent-browser, ai-research-explore, docx, maoying-*`） | PASS |
| 专家进会话 | `expertBlock=true expert=程枢`，`applied:true`（`ai-agent-engineer@1.0.0`），后续请求 system 含专家正文 | PASS |

一条环境坑：隔离 `DSH_HOME` 里没有 `workbuddy-vault/`，所以首次跑探针时 portal 三个动作全部返回
`WORKBUDDY_HELPER_PORTAL_AUTH_REQUIRED`。把真实 home 的 vault 复制进隔离 home（4 个账号文件）后立刻通过——
这不是代码缺陷，而是"凭据跟着 `DSH_HOME` 走"的正确行为，已记入 AGENTS.md 陷阱 17。


---

## 5. 过程中发现并修掉的 6 个真实缺陷

这些都不是"测试写错"，而是插件在真实宿主上确实会出错的地方：

1. **`tools` 服务没有 `definitions()`。** 宿主公开面是 `register/restrict/guard/view/get/schemas/schemaOf`。原代码只探测 `definitions` → `toolCount` 恒 0 → 连上的连接器永远显示"未连接"。改为 `definitions()` → `schemas()` 回退，并过滤无 `name` 的条目。
2. **空 patch 被写成 flow 风格。** `cordis.patch.yml` 初始是 `[]`（flow 序列），往里塞条目会变成 `{ insert: [ … ] }`，人读不了、diff 噪声大。改为检测"空且 flow"时转 block。
3. **`applying` 布尔吞掉真实变更。** `setSession()` 自己会调一次 `reapply()`，紧接着调用方的 `reapply(agent)` 命中布尔直接返回 → "取消停用"被静默丢弃，deny 一直是旧的。改为每个 agent 一条 promise 队列串行化。
4. **`connectors.init()` 从未被调用。** `lib/index.js` 创建了 controller 却没 `init()`，四个生命周期钩子（`agent/created`、`agent/pre-step`、`agent/disposed`、`tools/change`）一个都没注册 → `tools.restrict` 永远不被调用，停用的连接器工具照样能被模型调到。补上 `init()`，并加测试锁死四个钩子的注册。
5. **全局停用不进 deny 列表。** `connectorNamesFor()` 只看会话级 `disabled`，`record.enabled === false` 不影响工具可见性——"停用"沦为纯显示状态。改为两者合并。
6. **`disconnect` 返回 `status:'connected'`。** 借用 `success:true` 分支，UI 会显示"已连接"而其实刚把 patch 条目删掉。新增 `disconnected` 终态，并把 `connecting` 文案改成读 `state.reason`（原来读错层级，`restart-required` 提示永远不出现）。

另外两处实现层的坑（不是缺陷，但会误导后来者）：

- `mcp_connector.json` 在 `$DSH_HOME/storages/`，不在 profile 目录下；
- 目录里 `servers[0]` 有三种形状（`url` / `stdio+command` / `headerCredentialBindings`），只支持 `url` 会让 45 条 stdio 连接器全部报"没有可用的 server url"。

---

## 6. 已知局限

1. **OAuth 类连接器（19/134）不自研授权。** 点击"连接"只会把用户交接给 `dsh-mcp-connector` 的 `/mcp-connector/ui`；两边状态不共享，本插件只能看到"未绑定"。
2. **patch 生效依赖重启。** `patchReload:'live'` 的宿主会即时挂载（探针里观察到了），但默认配置下需要重启，所以状态保留 `restart-required` 这一显式中间态。
3. **工具枚举是静态快照。** `schemas()` 反映的是"当前进程已注册工具"，连接后需要等 `waitForTools()` 轮询窗口（默认 8s）才可能变 `connected`。
4. **`unbind` 只撤本地凭据。** 远端 revoke 做不到（WorkBuddy 有 `connectorService.unbind` 的远端注销，本插件没有对应通道）。
5. **134 条目录里有 50 条 `none` 认证的 http 连接器未逐一实连**，只做了表单/patch 层面的验证。

---

## 7. 复现

```powershell
# 1) 单元测试
node --test test/*.test.mjs

# 2) 打包
npm pack --pack-destination .workbuddy/probe/pack-v5

# 3) 装到隔离 profile（不要用真 home）
$env:DSH_HOME="E:\DSH\workspace\migrate\.workbuddy\probe\dshhome"
node "C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  plugin --profile wbhelper-work add "file:E:/DSH/workspace/migrate/.workbuddy/probe/pack-v5/dsh-workbuddy-helper-0.6.0.tgz"

# 4) 端到端探针（假模型 + 真 headless 会话）
$env:PROBE_PORT="9899"; $env:PROBE_PROFILE="wbhelper-work"
$env:PROBE_PLAN='[{"label":"state","input":{"action":"connector","connectorAction":"state","connectorId":"amap"}}]'
node .workbuddy/probe/probe-multi.mjs
```

注意：同一路径重装 tgz 时 pnpm 会报 `Already up to date` 并保留旧内容，必须换目录/文件名（本报告用 `pack-v2…v5` 逐版验证）。
