# DSH 专家中心插件（dsh-workbuddy-helper）设计方案

- 版本：v1 草案
- 日期：2026-11-22
- 目标宿主：DeepSeek Harness 0.2.x（本机 dsh-tui 0.18.0，desktop profile）
- 目标：在 DSH 会话内像 WorkBuddy 一样选择、切换、移除专家与技能，专家市场沿用 WorkBuddy 市场，专家与技能严格按会话隔离，可选注入 WorkBuddy 身份凭据。

> **2026-11-22 修正（重要）**：本文最初把公开 COS 的 `expert_center.json` 当成“WorkBuddy 专家市场”，因此记录了 429 条。该文件只是周期性发布的**快照**（`lastUpdated=2026-08-18`）。App 实际读取的是在线市场 `POST https://www.workbuddy.cn/portal/operation-platform/market/expert/list`，需要账号 token；未过滤时 `total_count=10000`，16 个分类。本机 `rea-reverse-engineer`（软件逆向分析工程师）与 `senior-fullstack-engineer`（高级全栈工程师）都来自在线市场，且都不在 429 条快照里。当前实现以在线市场为主、快照兜底，见 `lib/portal.js`。

---

## 0. 结论

1. 不需要改 DSH 内核，也不需要重启。DSH 已具备按 Agent 隔离的注册机制：`Agent.ctx` 是 agent 作用域上下文，通过它注册的提示段、工具、技能 provider 只对该 Agent 可见，销毁时自动回滚。
2. 会话隔离用“agent 作用域子插件 + 两个技能 provider + 每会话 sidecar”实现，不写全局 `cordis.patch.yml`、不改用户技能目录、不启用/禁用磁盘上的 `SKILL.md`，因此不会污染其他会话。
3. WorkBuddy 在线市场需要账号：`POST /portal/operation-platform/market/expert/list` 未带 token 返回 401，带 connector 的 `Authorization: Bearer` 返回 `total_count=10000`。公开 COS 只提供 429 条快照，作为无账号时的离线兜底。默认 `auth.mode=auto`，有 connector token 就用在线市场，没有就用快照；凭据只存 DSH 凭据服务或 connector vault，不进配置、不进日志、不回显给前端。

---

## 1. 已核验事实（本机，2026-11-22）

| 事实 | 证据 |
|---|---|
| WorkBuddy 在线市场需要账号 | `POST https://www.workbuddy.cn/portal/operation-platform/market/expert/list` 无 token 返回 401；带 connector `Authorization: Bearer` 返回 `code=0`、`total_count=10000` |
| 在线市场规模 | 100 条/页，100 页可读，第 101 页为空；16 个分类（`expert-categories`） |
| 在线市场专家包 | `POST .../expert/download-url` 返回签名 ZIP（CDN `openplatform-cdn.codebuddy.cn`）；解包后同样是 `.codebuddy-plugin/plugin.json` + `agents/` + `skills/` |
| 公开快照可匿名读取 | `GET https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace/expert_center.json` 返回 200，大小 1,158,100 字节 |
| 快照规模 | `experts` 429 条，`categories` 15 个，`lastUpdated=2026-08-18`；不含 `rea-reverse-engineer` / `senior-fullstack-engineer` |
| 专家包公开可下载 | `GET .../expert-marketplace/bundles/content-creator.tar.gz` 返回 200，677,238 字节 |
| 专家包结构 | `.codebuddy-plugin/plugin.json`、`agents/*.md`、`skills/*/SKILL.md`、`avatars/*`、`license/*` |
| 本机已安装专家可直接复用 | `~/.workbuddy/plugins/marketplaces/experts/plugins/<id>/.codebuddy-plugin/plugin.json`，例如 `ai-agent-engineer` |
| DSH 按 Agent 隔离注册 | `Agent.ctx`：`dsh-agent` README 与 `runtime-types.ts`；`dsh-scope` 按 scope 分层，销毁 scope 回滚全部注册 |
| 系统提示段可运行时注册 | `ctx.systemPrompt.section({name, order, text})` 返回 Cordis disposer；agent 作用域注册只影响该 agent |
| 技能目录按 agent scope 读取 | `dsh-tool-skill` 源码使用 `{ scope: agent }` 调用 `ctx.skills.list/get/snapshot` |
| 技能 provider 可按 agent 注册 | `ctx.skills.registerProvider()` 注册到调用上下文所在层；`SkillViewOptions.scope` 可显式读取全局层 |
| 工具限制必须用 agent scope | `ctx.tools.restrict()` 明确要求 `agent.ctx`，全局限制会拒绝 |
| Web 输入区插槽存在 | `conversation.input.left`、`conversation.input.right`、`conversation.composer`、`conversation.input.overlay` |
| 侧栏整页插槽存在 | `sidebar.panellist` + `main`，`dsh-skill-mcp-panel` 已用同一套机制 |

结论：技术路径成立，且有现成同类插件（`dsh-skill-mcp-panel`、`dsh-maoying`）可作为宿主端与客户端注册方式的参照。

---

## 2. 需求理解与假设

### 2.1 五要素

| 项 | 内容 |
|---|---|
| 目标 | 在当前 DSH 会话中自由选择/切换/移除专家与技能；不同会话互不影响；专家来源沿用 WorkBuddy 市场；可注入 WorkBuddy 身份 |
| 输入 | `sessionId`、`expertId`、技能名集合、可选凭据（token） |
| 输出 | 该会话的 system prompt 专家段、该会话可见的技能目录、UI 中的激活状态；持久化到每会话 sidecar |
| 成功指标 | 切换后下一条模型请求生效；两会话隔离测试 100% 通过；安全用例 100% 通过；缓存命中切换 P95 < 300ms；冷启动选专家 P95 < 5s；专家段默认 ≤ 60k 字符 |
| 约束 | 不改 DSH 内核；不改全局配置；不修改 WorkBuddy 安装目录；凭据不入配置文件与日志；DSH 0.2.x 兼容 |
| 风险 | 专家提示词注入、专家包供应链、身份凭据泄露、DSH API 漂移、上下文膨胀、子代理/分叉会话继承语义 |

### 2.2 兜底假设

- 单会话最多 1 个激活专家；技能最多 64 个；专家提示词上限 60,000 字符；专家技能正文单条上限 200,000 字符。
- 新会话在用户第一次操作时已有 `sessionId`；若没有，UI 暂存选择，在 `agent/created` 时按草稿绑定（见 7.6）。
- 子代理默认不继承专家人格；分叉会话默认不继承（v1 非目标，v1.1 再评估）。
- 专家市场以公开 COS 为主源，本机已安装专家为离线源；企业网关作为可选第三源。
- 身份注入默认关闭；只有市场返回 401/403 或用户显式切换 `auth.mode` 时才需要。

---

## 3. C3：这个需求真的需要 Agent 吗

不需要。这是一个确定性的宿主插件，不是自主 Agent：

- 专家选择是用户意图，不能让 LLM 替用户改人格；因此不设计“模型自主路由专家”的循环。
- 技能启用是确定性的集合运算，不需要 LLM 判断；由 UI/命令驱动，provider 按集合过滤。
- 唯一可选的模型能力是“根据任务推荐专家”，那应是一个只读工具，返回候选并等待用户确认；v1 不做，避免引入越权切换与额外 token 成本。

因此本方案不引入 `while` 循环、不引入自主规划器，也不把工作流包装成 Agent。

---

## 4. 总体架构

```mermaid
flowchart TB
  subgraph Client["DSH Web Client"]
    UI1["输入区 + 按钮"]
    UI2["专家选择器 / 技能选择器 / 身份页"]
    UI3["激活态胶囊（专家名 + 技能数）"]
  end

  subgraph Host["dsh-workbuddy-helper Host Plugin"]
    GW["RemoteGateway<br/>Typert RPC"]
    SR["SessionRegistry<br/>apply / switch / clear"]
    SS["SessionStore<br/>sidecar 原子读写"]
    MC["MarketClient<br/>manifest / bundle / cache"]
    AR["AuthResolver<br/>credentials + allowlist"]
    SP["SessionExpertPlugin<br/>agent-scoped child plugin"]
    TP["Telemetry / Audit"]
  end

  subgraph Core["DSH Core Services"]
    AG["ctx.agents"]
    SM["ctx.systemPrompt"]
    SK["ctx.skills"]
    CM["ctx.commands"]
    CR["ctx.credentials"]
  end

  subgraph Sources["专家来源"]
    WB["WorkBuddy Expert Market<br/>COS manifest + bundles"]
    LOCAL["本机 WorkBuddy 专家<br/>marketplaces/experts/plugins"]
  end

  UI1 --> UI2
  UI2 -->|RPC| GW
  UI3 -->|RPC| GW
  GW --> SR
  SR --> SS
  SR --> MC
  MC --> AR
  MC --> WB
  MC --> LOCAL
  SR -->|agent.ctx.plugin| SP
  SP --> SM
  SP --> SK
  SP --> CM
  AR --> CR
  SR --> AG
  GW --> TP
```

### 4.1 组件职责

| 组件 | 职责 | 输入 | 输出 | 失败处理 |
|---|---|---|---|---|
| Client UI | 输入区入口、选择器、激活态、身份页 | 用户操作、会话视图 | RPC 调用 | 断线重连、错误 toast、保留草稿 |
| RemoteGateway | 暴露类型化 RPC，校验参数与权限 | UI 请求 | 视图模型 / 错误码 | 参数校验失败即拒绝；不泄漏内部异常 |
| SessionRegistry | 解析专家、串行化切换、挂载/销毁子插件、持久化 | sessionId、expertId、技能集合 | SessionView | 失败回滚到上一状态；旧 fiber 不泄漏 |
| SessionStore | 每会话 sidecar，原子写，保留期清理 | SessionState | JSON 文件 | 写失败不回滚内存态；下次重试 |
| MarketClient | 清单拉取、缓存、ETag、超时重试、bundle 下载 | baseUrl、auth、expertId | ExpertPackage | 过期缓存兜底；失败给可执行错误 |
| AuthResolver | 凭据解析、请求头注入、host 允许列表、脱敏 | credentialRef、mode | header 或 undefined | 401/403 不重试；不跨 host 发送 |
| SessionExpertPlugin | agent 作用域内注册提示段与技能 provider | expert prompt、技能数据、state | 注册副作用 | 任一注册失败即整体回滚 |
| Telemetry/Audit | trace、指标、审计 | 操作事件 | 日志/计数 | 失败只降级，不影响主流程 |

---

## 5. 目录结构

```text
dsh-workbuddy-helper/
├─ package.json
├─ cordis.patch.yml
├─ lib/
│  ├─ index.js              # 宿主入口：配置、服务装配、命令、agent 生命周期
│  ├─ config.js             # Schemastery 配置 schema 与校验
│  ├─ market.js             # 清单拉取、缓存、分页、来源合并
│  ├─ bundle.js             # tar.gz 下载、安全解包、plugin.json 解析
│  ├─ auth.js               # 凭据解析、允许列表、脱敏
│  ├─ session-store.js      # sidecar 原子读写、保留期清理
│  ├─ session-registry.js   # 选择/切换/清除、串行化、回滚
│  ├─ session-plugin.js     # agent 作用域子插件（提示段 + provider）
│  ├─ skill-providers.js    # workbuddy-helper-expert provider + global filter provider
│  ├─ remote.js             # Typert 远程服务与 manifest
│  ├─ telemetry.js          # traceId、指标、审计
│  └─ errors.js             # 稳定错误码
├─ client/
│  ├─ index.js              # Web 客户端入口：插槽注册、RPC 调用
│  ├─ picker.jsx            # 专家/技能/身份三页选择器
│  ├─ chips.jsx             # 输入区激活态
│  └─ styles.css
├─ skills/
│  └─ dsh-workbuddy-helper/
│     └─ SKILL.md           # 可选：教模型如何配合专家/技能
├─ test/
│  ├─ unit/                 # 纯函数与安全用例
│  └─ e2e/                  # 双会话隔离、恢复、恶意 bundle
└─ README.md
```

---

## 6. 关键模块

### 6.1 MarketClient

职责：

- 拉取 `expert_center.json`，校验 `version / experts / categories`，缓存到 `$DSH_HOME/workbuddy-helper/cache/manifest.json`。
- 记录 `etag / lastModified / fetchedAt / sourceUrl`；TTL 默认 6 小时；请求失败时允许使用 7 天内的 stale 缓存。
- 列表查询在宿主侧过滤、分页，避免把 1.1MB 清单整体发给前端。
- 合并来源：`market`、`local`、`hybrid`；同 `plugin` 名以版本高者为准，版本相同优先本地。
- 只信任 `allowHosts` 内的 HTTPS 地址；bundle 下载前再次校验最终 URL。

关键接口：

```text
listExperts({ query, categoryId, source, cursor, limit }) -> { items, nextCursor, total }
getExpert(expertId) -> ExpertDetail
refreshManifest({ force }) -> { version, fetchedAt, stale }
```

失败处理：

- 超时/网络错误：指数退避 + 抖动，最多 2 次重试；仍失败用 stale 缓存；无缓存则返回 `MARKET_UNREACHABLE`，UI 提示检查网络或改用本地专家。
- 401/403：返回 `MARKET_AUTH_REQUIRED`，不重试；UI 引导到身份页。
- 429：读 `Retry-After`，没有则按退避；返回 `MARKET_RATE_LIMITED`。
- 清单 schema 不合法：拒绝缓存，保留上一份；返回 `MARKET_SCHEMA_INVALID`。

### 6.2 BundleStore

职责：

- 下载 `bundles/<plugin>.tar.gz` 到临时文件；限制 50MB、30 秒超时。
- 安全解包：拒绝绝对路径、`..`、符号链接/硬链接、设备文件；只允许 `agents/`、`skills/`、`avatars/`、`.codebuddy-plugin/`、`README.md`；限制条目数 2,000、解包总量 50MB。
- 解析 `.codebuddy-plugin/plugin.json`（兼容 `.workbuddy-plugin/plugin.json`）；以 `agents[0]` 为提示词权威路径，缺失时回退清单 `promptFile`。
- 所有从包内读取的路径（提示词、技能、资源）先 `path.resolve`，再校验仍位于 bundle 根目录内；越界即拒绝。
- 以 `plugin@version` 的 SHA-256 作为缓存目录名，避免路径注入；记录首次下载的 bundle SHA-256，后续变化时告警（TOFU，不是签名）。
- 读取技能：解析 `SKILL.md` 的 YAML frontmatter，得到 `name / description / whenToUse / invocation`；正文与 `resourceBase` 一并缓存。

失败处理：

- 404：专家已下架，返回 `EXPERT_NOT_FOUND`，保持上一激活状态。
- 解包失败/超限：删除临时目录，返回 `BUNDLE_REJECTED`；不缓存半成品。
- 提示词为空/超大：截断到上限并记录 `PROMPT_TRUNCATED`；空提示词直接拒绝。

### 6.3 SessionRegistry

职责：

- 维护 `sessionId -> LiveSession`（fiber、state、refresh 函数、revision）。
- 所有变更按 session 串行化（Promise 队列 + generation 计数），避免快速切换导致旧异步结果覆盖新状态。
- 选择流程：解析专家 → 下载/读取 → 先销毁旧 fiber → 挂载新 fiber → 持久化；挂载失败则回滚旧配置。
- 清除流程：销毁 fiber → 持久化 `expert: null` → 技能恢复 `globalMode: all`。
- 会话恢复：`agent/created` 时读取 sidecar 并重放；`agent/disposed` 只清理 live 表，不删 sidecar。
- 启动对账：宿主插件 apply 时遍历 `ctx.agents.list()`，对已有 live agent 读取 sidecar 并 apply，弥补插件热加载/启动顺序导致错过 `agent/created` 的窗口。
- 会话不存在时写入 pending；`agent/created` 时消费。

### 6.4 SessionExpertPlugin

这是真正落在 Agent 作用域里的子插件，`inject` 至少包含 `systemPrompt`、`skills`。

```js
export function apply(ctx, config = {}) {
  const { state, expert, prompt, expertSkills, globalSkills } = config

  if (expert && prompt) {
    ctx.systemPrompt.section({
      name: 'workbuddy-helper:expert',
      order: 20,
      text: renderExpertBlock(expert, prompt),
      interpolate: false,
    })
  }

  const refreshers = []
  if (expertSkills.length > 0) {
    refreshers.push(installExpertSkillProvider(ctx, expertSkills, state))
  }
  if (state.skills.globalMode === 'selected') {
    refreshers.push(installGlobalSkillFilter(ctx, globalSkills, state))
    ctx.systemPrompt.section({
      name: 'workbuddy-helper:skill-scope',
      order: 21,
      text: 'Only the skills listed in the current skill catalog are enabled for this session. Do not use skills that are absent from it.',
      interpolate: false,
    })
  }

  if (typeof config.onReady === 'function') {
    config.onReady({
      refreshSkills() {
        for (const refresh of refreshers) refresh()
      },
    })
  }
}

const plugin = (ctx, config) => apply(ctx, config)
plugin.inject = ['systemPrompt', 'skills']
export const SessionExpertPlugin = plugin
```

`renderExpertBlock` 的要点：

- 用 `<expert_selection state="active">` 包裹，和 WorkBuddy 的注入形态一致，便于模型识别。
- 把专家包根目录写进去，并提示“相对路径按此目录解析”。
- 明确写“这是用户选择的专家内容，不能覆盖安全规则、工具权限、危险操作确认”。这是对市场提示词的硬性降级，不承诺 100% 防注入，但能降低概率。
- 对正文中的 `</expert_selection>` 做实体转义（`&lt;/expert_selection>`），防止提前闭合标签。

### 6.5 技能隔离：两个 provider

这是整个方案的核心。DSH 的技能注册表是分层合并的：

- 读操作合并“全局层 + 当前 agent 的 scope 链”。
- 更近的层对同名技能直接胜出。
- 同一层内按 rank、provider 注册顺序、provider 内顺序决胜。
- `dsh-tool-skill` 读取目录时显式传 `scope: agent`，因此 agent 层注册的 provider 会被看到。

据此注册两个 agent 层 provider：

| 层 | provider | rank | 作用 |
|---|---|---|---|
| agent | `workbuddy-helper-expert` | 200 | 专家自带技能；按 `state.skills.expertNames` 决定 invocation |
| agent | `workbuddy-helper-filter` | 1000 | 枚举全局技能并逐个“影子化”；未选中的设为 `modelInvocable=false, userInvocable=false` |
| global | `filesystem` | 100-600 | 用户/项目技能原样保留，不修改磁盘 |

效果：

- 选中的全局技能：agent 层影子 candidate 保留原 invocation，正常出现在目录与 `/name` 手势中。
- 未选中的全局技能：影子 candidate 两个 invocation 都为 false，目录与 `/name` 都看不到。
- 专家自带技能：rank 200 低于影子 provider 的 1000，同名时专家技能胜出；未选中的专家技能同样以 false/false 隐藏。
- 不需要 shadow `skill` 工具，不需要 `ctx.tools.restrict`，原生技能目录、`skill` 工具、`/name` 手势全部继续工作。

选择专家时，`state.skills.expertNames` 默认初始化为该专家 `plugin.json` 中声明的全部技能名；用户取消勾选后再从集合移除。专家没有技能时不注册 `workbuddy-helper-expert` provider。

同名冲突规则：专家包与全局技能同名时，专家包拥有该名字；即使用户取消勾选该专家技能，也会连同全局同名技能一起隐藏。UI 在专家详情里标出冲突并提示“该名字由专家包接管”。这样避免同一名字在两个 provider 之间来回切换，行为可预测。

provider 的 `list()` 读全局层时显式传 `scope: undefined`，避免递归读到自己：

```js
async list(options) {
  const snapshot = await globalSkills.snapshot({
    cwd: options.cwd,
    signal: options.signal,
    scope: undefined,
  })
  const enabled = state.skills.globalMode === 'selected'
    ? new Set(state.skills.globalNames)
    : undefined
  return {
    candidates: snapshot.skills.map(skill => ({
      ...skill,
      rank: 1000,
      locator: { name: skill.name },
      invocation: enabled === undefined || enabled.has(skill.name)
        ? skill.invocation
        : { modelInvocable: false, userInvocable: false },
    })),
    complete: snapshot.complete,
  }
}
```

`get()` 只在选中时委托全局注册表读取正文：

```js
async get(candidate, options) {
  const enabled = state.skills.globalMode === 'selected'
    ? new Set(state.skills.globalNames)
    : undefined
  if (enabled !== undefined && !enabled.has(candidate.name)) return undefined
  return globalSkills.get(candidate.name, {
    cwd: options.cwd,
    signal: options.signal,
    scope: undefined,
  })
}
```

技能开关变化时只需修改 `state` 并调用 provider 的 `invalidate()`；下一次 `agent/pre-step` 会重新快照目录，`dsh-tool-skill` 会追加一份替换目录。无需重挂子插件。

### 6.6 SessionStore

路径：`$DSH_HOME/workbuddy-helper/sessions/<sha256(sessionId)>.json`，文件权限 0600，原子写（临时文件 + rename）。

示例（`sessionId`、路径、哈希值做了省略，仅示意结构）：

```json
{
  "schemaVersion": 1,
  "sessionId": "sess_...",
  "revision": 7,
  "expert": {
    "id": "ai-agent-engineer",
    "plugin": "ai-agent-engineer",
    "version": "1.0.0",
    "displayName": "程枢",
    "root": "C:/Users/.../workbuddy-helper/cache/bundles/<hash>",
    "promptSha256": "…",
    "promptChars": 18234,
    "source": "local"
  },
  "skills": {
    "globalMode": "selected",
    "globalNames": ["xlsx", "docx"],
    "expertNames": ["agent-craft"]
  },
  "updatedAt": "2026-11-22T06:00:00.000Z"
}
```

提示词正文不重复存进每个会话，按 `promptSha256` 存在 `cache/prompts/<hash>.md`；sidecar 只存哈希与路径。这样恢复会话时不必重新下载，也避免每会话复制一份大文本。

### 6.7 生命周期与并发

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Resolving: select / switch
  Resolving --> Applying: bundle + prompt ready
  Resolving --> Idle: error, keep previous
  Applying --> Active: child fiber mounted
  Applying --> Idle: mount failed, rollback
  Active --> Active: toggle skills (invalidate)
  Active --> Resolving: switch expert
  Active --> Idle: clear / agent disposed
```

并发规则：

- 每个 session 一条串行队列；`select`、`clear`、`setSkills` 不并发执行。
- 每次 apply 带 `generation`；异步下载返回时若 generation 已过期，直接丢弃结果，不挂载。
- 先销毁旧 fiber，再挂载新 fiber；挂载抛错时尝试恢复旧配置；恢复失败则进入 Idle 并返回 `APPLY_ROLLED_BACK`，UI 显示“已回到未选择状态”。
- 模型步骤正在执行时，提示段与技能目录在下一步生效；UI 明确写“下一条消息生效”，不假装当前步骤即时改变。

---

## 7. 会话级隔离实现要点

### 7.1 为什么不用 Agent Preset

Agent Preset 是创建期组合：定义在 `cordis.patch.yml` 里，会话创建时选一个，运行中的 Agent 组合保持稳定；编辑只影响后续新建的 Agent。它适合“一个专家一个预设、开新会话”，不适合“当前对话中随时切换”。若用预设实现切换，需要销毁并重建 Agent，历史、进行中的轮次、审批状态都很难无损迁移。

### 7.2 为什么不用全局技能启停

`dsh-skill-mcp-panel` 的启停是改磁盘上的 `SKILL.md`（`.disabled` 改名），这是全局/工作区级，不是会话级。用它做“会话内技能开关”会污染其他会话，违背需求。

### 7.3 隔离边界

| 资源 | 隔离方式 | 是否影响其他会话 |
|---|---|---|
| 专家提示词 | `agent.ctx.systemPrompt.section`，fiber 销毁即移除 | 否 |
| 专家技能 | agent 层 `workbuddy-helper-expert` provider | 否 |
| 全局技能开关 | agent 层 `workbuddy-helper-filter` 影子 provider | 否 |
| UI 激活态 | 按 sessionId 查询 sidecar | 否 |
| 凭据 | 全局凭据服务，所有会话共享同一市场身份 | 是（身份是账号级，不是会话级） |
| 市场缓存 | 全局磁盘缓存，只读共享 | 是（只影响性能，不影响语义） |

### 7.4 恢复与销毁

- `agent/created`：读 sidecar，若存在则 apply；`source` 为 resume 时同样适用。
- 插件启动/热加载：遍历 `ctx.agents.list()` 做一次对账，避免错过已创建 Agent 的 `agent/created`。
- `agent/disposed`：从 live 表移除；sidecar 保留，供下次 resume。
- 会话归档/删除：监听 `session/disposed` 只做标记；sidecar 按 `retentionDays` 清理，避免误删可恢复会话。
- 插件卸载：agent 作用域 fiber 随宿主卸载自动回滚；sidecar 与缓存保留，重装后可继续用。
- 崩溃恢复：sidecar 是唯一事实源；启动时不需要全量扫描，按需读取。

### 7.5 切换的原子性

1. 解析新专家（网络/磁盘）。
2. 计算新状态，写 `applying` 标记到内存。
3. 销毁旧 fiber（若失败，中止，保留旧状态）。
4. 挂载新 fiber（若失败，尝试重建旧 fiber；重建失败则 Idle）。
5. 写 sidecar（若失败，内存态仍生效，标记 `persistDirty`，下次操作重试）。
6. 返回新视图与 `revision`。

### 7.6 新会话没有 sessionId 的兜底

UI 在空白新会话中拿不到 `sessionId` 时：

- 选择结果暂存在客户端草稿（`draftExpert` / `draftSkills`）。
- 首条消息发送前，调用 `beginDraft()` 获取一次性 `draftToken`；host 记录 token → 选择。
- `agent/created` 时按 token 绑定并清除。
- 如果同一客户端并发多个空白会话，UI 禁止同时保留多个 draft，提示“请先发送当前会话首条消息”。这是显式降级，不猜测归属。

`[待核实: DSH Web 新建空白会话时是否已经分配 sessionId；核实方式：读 dsh-client-ui-session 源码或在桌面端新建会话后查 sessions.list]`

### 7.7 明确不隔离的部分

- 子代理：子代理有自己的 Agent 与 Session，默认不继承专家。若需要继承，v1.1 通过 `parentSession` 关系在子 Agent 创建时复制轻量人格段；这会增加复杂度，v1 不做。
- 分叉会话：fork 产生新 sessionId，默认不继承；v1.1 可按 `origin` 复制 sidecar。
- 凭据：账号级共享，这是身份语义，不是会话语义。
- 市场缓存：全局共享，只读。

---

## 8. 专家市场接入与身份注入

### 8.1 来源模式

| 模式 | 行为 | 适用 |
|---|---|---|
| `market` | 只读远程清单与 bundle | 默认；有网 |
| `local` | 只读本机 WorkBuddy 已安装专家 | 离线、企业内网、想用自己已装的专家 |
| `hybrid` | 合并两者，同 plugin 名版本高者胜，版本相同本地优先 | 推荐默认值 |

本地根：

```text
~/.workbuddy/plugins/marketplaces/experts/plugins
~/.workbuddy/plugins/marketplaces/my-experts
```

只读，不修改 WorkBuddy 安装目录。

### 8.2 市场与包地址

在线市场（主）：

```text
list:        POST <portal>/operation-platform/market/expert/list
categories:  GET  <portal>/operation-platform/market/expert-categories
detail:      POST <portal>/operation-platform/market/expert/get-by-ids
bundle:      POST <portal>/operation-platform/market/expert/download-url  -> signed ZIP
```

公开快照（兜底）：

```text
manifest:  <baseUrl>/expert_center.json
bundle:    <baseUrl>/bundles/<plugin>.tar.gz
avatar:    <baseUrl>/avatars/<id>.png
```

`portal` 默认 `https://www.workbuddy.cn/portal`；若 connector 账号记录里有 `auth.domain`，优先用该域名的 `https://` origin。`baseUrl` 默认：

```text
https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace
```

bundle 的 `<plugin>` 取 `expert.plugin ?? expert.agentName ?? expert.id`；三者都缺失时该专家条目标记为不可安装，UI 显示“缺少安装标识”，不猜测。

### 8.3 身份注入配置

默认：

```yaml
auth:
  mode: none
```

需要时：

```yaml
auth:
  mode: bearer                  # none | bearer | header | cookie
  credentialRef: WB_EXPERT_TOKEN
  headerName: Authorization
  headerPrefix: "Bearer "
  allowHosts:
    - acc-1258344699.cos.accelerate.myqcloud.com
  allowInsecureLoopback: false
```

字段说明：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | enum | `none` | `none` 不附加任何头；`bearer` 拼 `Authorization: Bearer <token>`；`header` 自定义头；`cookie` 整段 Cookie |
| `credentialRef` | string | `WB_EXPERT_TOKEN` | DSH 凭据服务中的键名，必须是 POSIX shell 标识符 |
| `headerName` | string | `Authorization` | `bearer` / `header` 模式使用 |
| `headerPrefix` | string | `Bearer ` | 拼在 token 前；`header` 模式可为空 |
| `allowHosts` | string[] | 默认市场 host | 只有这些 host 会收到凭据；改 `baseUrl` 必须同步改这里 |
| `allowInsecureLoopback` | boolean | `false` | 仅本地测试用；生产必须 false |

### 8.4 凭据流

```mermaid
sequenceDiagram
  participant U as 用户
  participant C as Web Client
  participant G as RemoteGateway
  participant CR as ctx.credentials
  participant M as MarketClient

  U->>C: 输入 token
  C->>G: setCredential(value)
  G->>CR: set(credentialRef, value)
  G-->>C: {configured: true, source: "stored"}
  Note over C,CR: 值不回传、不落配置、不进日志

  M->>CR: resolve(credentialRef)
  CR-->>M: {value, source}
  M->>M: allowlist + HTTPS 校验
  M->>M: 附加请求头
  M-->>M: fetch manifest / bundle
```

规则：

- 宿主必须已挂载 `dsh-credentials-local`（或等价凭据服务）；未挂载时 `auth.mode` 必须为 `none`，否则插件加载失败并提示缺少凭据服务。
- 凭据只从 `ctx.credentials.resolve(ref)` 读；配置里只出现键名。
- 设置/更新/清除通过 `ctx.credentials.set/unset`；`describe` 只返回 `{configured, source, writable, masked?}`，绝不返回值。
- 每次请求重新 resolve，支持轮换后下一次请求生效，无需重启。
- 日志、错误对象、审计只记录 `credentialRef` 与 `source`，不记录值；异常文本统一过 `redact()`。
- 请求头只发往 `allowHosts`；重定向手动处理，逐跳校验 host 与协议；最多 3 跳。
- 头像、分类图等静态资源不带凭据；只有 manifest 与 bundle 请求附加认证头。避免把 token 发给不必要的 CDN 请求。
- token 不放 URL、不放 query、不放 Cookie 之外的持久化位置；bundle 缓存键不含 token。

### 8.5 身份页字段

| 字段 | 控件 | 说明 |
|---|---|---|
| 认证模式 | 下拉 | `none / bearer / header / cookie`；默认 none |
| 凭据键名 | 文本 | 默认 `WB_EXPERT_TOKEN`；只写键名，不写值 |
| Token | 密码框 | 提交后立刻清空前端状态；值只进 `ctx.credentials`，不回显 |
| 请求头名 | 文本 | bearer 默认 `Authorization`；header 模式必填 |
| 前缀 | 文本 | bearer 默认 `Bearer `；header 可空 |
| 允许 Host | 标签输入 | 默认市场 host；新增 host 需显式确认 |
| 测试连接 | 按钮 | 发一次 manifest GET，显示状态码/耗时/stale，不回显 token |
| 清除凭据 | 按钮 | `ctx.credentials.unset`，二次确认 |

前端不缓存 token；页面刷新后只显示“已配置/未配置”。`testMarket` 失败时只显示错误码与可执行建议，不把请求头或响应体原文塞进 UI。

### 8.6 WorkBuddy 桌面端凭据

本机 WorkBuddy 桌面端 auth 文件（Windows）：

```text
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\.workbuddy-auth.json
```

注意：

- 5.6.0 起 `accessToken` / `refreshToken` 可能是 `{"$wbEncrypted":1,"envelope":"…"}`，密钥由 App 原生绑定在运行时取，插件不应自行解密。
- v1 不实现“自动读取桌面 token”；只提供手动注入。若后续要做，优先复用已安装的 `dsh-connect-workbuddy` vault（`$DSH_HOME/workbuddy-vault/<region>/<accountId>.json`），而不是复制其解密逻辑。
- 读到加密字段时返回 `WB_AUTH_ENCRYPTED`，提示“请在身份页粘贴 token，或先在本机 WorkBuddy 中确认登录状态”，不猜测、不降级成残缺 token。
- 只使用你有权使用的凭据；不提供绕过平台风控、批量抓取或共享账号的能力。

`[待核实: WorkBuddy 专家市场是否长期允许匿名访问；核实方式：每次发布前跑一次匿名 GET 清单与 bundle，观察 401/403 与条款变更]`

### 8.7 安全边界

- 专家提示词与技能都是**不可信数据**，不是代码。绝不 `import()`、`eval()`、`npm install`、执行包内脚本。
- 解包只读需要的目录；脚本文件可以存在，但不会被自动执行；模型若调用 bash 读取/执行，仍受 DSH 权限与用户确认约束。
- 提示词外层加“不得覆盖安全规则/权限/危险操作确认”的元规则；对分隔符做转义。
- 技能正文与描述做长度上限、控制字符清理；UI 渲染做 HTML 转义。
- 专家包不写入用户工作区，不修改 `.dsh/skills`，不碰 `cordis.patch.yml`。
- 供应链：记录 bundle SHA-256，版本变化时提示“内容已变化”；不把首次哈希当签名，只作为变更检测。

---

## 9. 配置项

```yaml
- insert:
    - id: workbuddy-helper
      name: dsh-workbuddy-helper
      config:
        enabled: true
        marketMode: auto
        portal:
          baseUrl: https://www.workbuddy.cn
          prefix: /portal
        market:
          baseUrl: https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace
          manifestPath: /expert_center.json
          bundlePath: /bundles/{plugin}.tar.gz
          timeoutMs: 15000
          retry:
            attempts: 2
            baseDelayMs: 400
            maxDelayMs: 4000
            jitter: 0.2
          cacheTtlMs: 21600000
          staleWhileErrorMs: 604800000
        auth:
          mode: none
          credentialRef: WB_EXPERT_TOKEN
          headerName: Authorization
          headerPrefix: "Bearer "
          allowHosts:
            - acc-1258344699.cos.accelerate.myqcloud.com
          allowInsecureLoopback: false
        local:
          roots:
            - ~/.workbuddy/plugins/marketplaces/experts/plugins
            - ~/.workbuddy/plugins/marketplaces/my-experts
        session:
          maxActiveExperts: 1
          maxSelectedSkills: 64
          maxExpertPromptChars: 60000
          maxSkillBodyChars: 200000
          persist: true
          retentionDays: 30
        safety:
          maxBundleBytes: 52428800
          maxBundleFiles: 2000
          allowScripts: false
        ui:
          entry: composer
          showActiveChips: true
          locale: auto
        telemetry:
          auditRetentionDays: 30
          logPromptContent: false
```

| 配置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | true | 总开关；false 时不注册命令/UI，不加载市场 |
| `marketMode` | enum | auto | `auto`（在线优先、快照兜底）/ `portal` / `cos` |
| `market.baseUrl` | string | 见上 | 公开快照基址；必须是 HTTPS，且在 allowHosts 内 |
| `portal.baseUrl` | string | https://www.workbuddy.cn | 在线市场基址；账号 `domain` 优先 |
| `portal.prefix` | string | /portal | 在线市场路由前缀 |
| `market.timeoutMs` | number | 15000 | 单次请求超时 |
| `market.retry.attempts` | number | 2 | 重试次数（不含首次） |
| `market.cacheTtlMs` | number | 6h | 快照新鲜期 |
| `market.staleWhileErrorMs` | number | 7d | 出错时允许的 stale 窗口 |
| `auth.mode` | enum | auto | `auto / none / bearer / header / cookie / workbuddy-connector` |
| `auth.credentialRef` | string | WB_EXPERT_TOKEN | 凭据键名 |
| `auth.allowHosts` | string[] | 快照 + 在线市场 + CDN | 凭据可发送 / 包可下载的 host |
| `local.roots` | string[] | 两个 WorkBuddy 目录 | 本地专家根，只读 |
| `session.maxActiveExperts` | number | 1 | v1 固定 1 |
| `session.maxSelectedSkills` | number | 64 | 超过拒绝并提示 |
| `session.maxExpertPromptChars` | number | 60000 | 超限截断 |
| `session.retentionDays` | number | 30 | sidecar 保留期 |
| `safety.maxBundleBytes` | number | 50MB | 下载/解包上限 |
| `safety.maxBundleFiles` | number | 2000 | 条目上限 |
| `safety.allowScripts` | boolean | false | v1 不执行任何包内脚本；保留字段 |
| `ui.entry` | enum | composer | `composer / sidebar / both` |
| `telemetry.logPromptContent` | boolean | false | 默认不记录提示词正文 |

校验规则：

- `baseUrl` 必须 HTTPS；`allowHosts` 必须包含其 host。
- `credentialRef` 必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`。
- 数值字段给上下界；非法配置让插件加载失败并打印明确原因，不静默降级。
- 配置里出现 `token` / `password` / `secret` 字段直接拒绝加载，强制走凭据服务。

---

## 10. Web UI 集成

### 10.1 插槽

已核验的客户端插槽：

| 插槽 | 用途 |
|---|---|
| `conversation.input.left` | 输入框左侧“专家/技能”按钮与激活胶囊 |
| `conversation.input.right` | 可选：技能计数、身份状态 |
| `conversation.input.overlay` | 选择器浮层（锚定输入区） |
| `conversation.composer` | 需要整块替换输入区时使用（本方案不用） |
| `sidebar.panellist` + `main` | 可选：整页“专家中心”管理页 |

客户端插件清单：

```json
{
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-api-gateway",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-conversation"
      ]
    }
  }
}
```

`[待核实: conversation.input.left 的 owner props 与注册参数在当前 0.2.x 客户端版本中的精确类型；核实方式：读 dsh-client-ui-conversation/src/client/contract/slots.ts 与一个已装插件的实现]`

### 10.2 交互

- 输入区左侧一个“+”按钮，点开两项：**专家**、**技能**。选“专家”打开专家页，选“技能”打开技能页；已选择时按钮旁显示“专家名 · 技能数”的激活胶囊，胶囊上的 `×` 直接移除。
- 浮层三个页签：
  - 专家：搜索、分类、来源徽标（市场/本地）、版本、当前激活标记；点击“使用”即切换。
  - 技能：分“全局技能”和“专家自带技能”两组；复选；全选/清空；超过 64 禁用并提示。
  - 身份：认证模式、配置状态、密码输入、测试连接、清除；只显示“已配置/未配置”，不回显值。
- 底部固定一行：“仅作用于当前会话；切换后下一条消息生效”。
- 切换专家时，如果当前有未发送草稿，不清空草稿；只改会话级状态。
- 错误用可执行文案：`市场不可达，已使用 2 小时前的缓存`、`该专家包校验失败，已保留原专家`、`凭据无效，请更新 token`。

### 10.3 远程方法

| 方法 | 入参 | 返回 |
|---|---|---|
| `listExperts` | query/category/source/cursor | 分页摘要 |
| `getExpert` | expertId | 详情、技能列表、来源、版本 |
| `getSessionView` | sessionId | 当前专家、技能开关、revision、警告 |
| `selectExpert` | sessionId, expertId | 新视图 |
| `clearExpert` | sessionId | 新视图 |
| `setSkills` | sessionId, globalMode, globalNames, expertNames | 新视图 |
| `listSkills` | sessionId | 全局 + 专家技能摘要与开关 |
| `getAuthStatus` | 无 | configured/source/writable |
| `setCredential` | value | configured 状态（不回显值） |
| `clearCredential` | 无 | configured 状态 |
| `testMarket` | 无 | status、latencyMs、stale |
| `refreshManifest` | force | version、fetchedAt |

所有写方法带 `revision` 做乐观并发；不匹配返回 `REVISION_CONFLICT`，UI 重新拉取。

如果 Typert manifest 的接入成本高于预期，可退回 `ctx.webServer` 注册同源 JSON 路由（`dsh-maoying` 的 `/api/maoying/*` 就是这种做法），客户端用同源 `fetch`。二选一，不混用；同源路由同样要校验 sessionId 属于当前用户/当前连接。

`[待核实: Typert 远程服务 manifest 的完整 schema 与是否支持服务端推送；核实方式：读 dsh-typert-protocol 与 dsh-skill-mcp-panel 的 manifest]`

### 10.4 命令

- `/expert`：查看当前；`/expert off` 清除；`/expert <id>` 选择。
- `/skill`：查看；`/skill all` 全开；`/skill only a b c` 只开这些；`/skill +a -b` 增量。
- 命令 handler 直接对 receiving agent 操作，不产生模型消息；返回 `{kind:'success'|'error', text}`。
- 如果命令名已被其他插件占用，注册时捕获异常并降级为 `/workbuddy-helper`，UI 仍可用。

`[待核实: DSH 当前内置命令是否已占用 /expert 或 /skill；核实方式：启动后执行 /help 或读 commands 注册表]`

---

## 11. 错误处理矩阵

| 场景 | 检测 | 重试 | 用户可见 | 降级 |
|---|---|---|---|---|
| 市场超时 | AbortSignal | 2 次退避+抖动 | “市场不可达，使用缓存” | stale 缓存 |
| 市场 401/403 | status | 否 | “需要身份，请到身份页” | 本地专家仍可用 |
| 市场 429 | status/Retry-After | 按指示 | “请求过于频繁” | stale 缓存 |
| 清单 schema 非法 | 校验 | 否 | “市场数据异常” | 保留上一份 |
| bundle 404 | status | 否 | “专家已下架” | 保持原专家 |
| bundle 超限 | size/entry count | 否 | “专家包过大/异常” | 保持原专家 |
| 解包路径穿越 | 路径校验 | 否 | “专家包被拒绝” | 保持原专家 |
| 提示词超长 | 字符数 | 否 | “已截断到 60k” | 继续应用 |
| 提示词为空 | trim | 否 | “专家内容为空” | 保持原专家 |
| 提示词缓存缺失且重取失败 | 文件/下载 | 一次 | “专家内容不可用，已暂停该专家” | 标记 degraded，不清空技能选择但不注入人格 |
| 挂载失败 | 异常 | 否 | “切换失败，已回滚” | 恢复旧 fiber |
| sidecar 写失败 | IO 异常 | 下次操作 | 不打断当前会话 | 内存态继续 |
| 会话不存在 | agents.get 返回 undefined | 否 | “等待会话创建” | pending |
| 技能不存在 | 目录对比 | 否 | “部分技能已失效” | 其余继续 |
| 凭据解密失败 | `$wbEncrypted` | 否 | “请粘贴 token” | 不降级 |

错误码统一前缀 `WORKBUDDY_HELPER_`，例如：

```text
WORKBUDDY_HELPER_MARKET_UNREACHABLE
WORKBUDDY_HELPER_MARKET_AUTH_REQUIRED
WORKBUDDY_HELPER_MARKET_SCHEMA_INVALID
WORKBUDDY_HELPER_BUNDLE_REJECTED
WORKBUDDY_HELPER_PROMPT_TRUNCATED
WORKBUDDY_HELPER_SESSION_NOT_LIVE
WORKBUDDY_HELPER_REVISION_CONFLICT
WORKBUDDY_HELPER_APPLY_ROLLED_BACK
```

---

## 12. 可观测性

### 12.1 trace

每个用户动作生成 `traceId`，贯穿：

```text
select_expert
  ├─ market.resolve_expert
  ├─ bundle.ensure (download / extract)
  ├─ session.dispose_previous
  ├─ session.mount_child
  └─ session.persist
```

日志字段：`traceId, sessionIdHash, action, expertId, version, source, skillCount, promptChars, durationMs, result, errorCode`。不记录 sessionId 明文（用哈希）、不记录提示词正文、不记录 token。

### 12.2 指标

| 指标 | 类型 | 说明 |
|---|---|---|
| `expert_center_market_fetch_total` | counter | 按 result 分 |
| `expert_center_market_fetch_ms` | histogram | P50/P95 |
| `expert_center_bundle_download_ms` | histogram | 冷启动 |
| `expert_center_apply_total` | counter | ok/rollback/error |
| `expert_center_active_sessions` | gauge | 当前有专家的会话数 |
| `expert_center_prompt_chars` | gauge | 专家段字符数 |
| `expert_center_skill_count` | gauge | 会话启用技能数 |
| `expert_center_auth_failures_total` | counter | 按状态码 |

若宿主没有通用 metrics 服务，降级为结构化日志 + 进程内计数，通过 `/workbuddy-helper stats` 命令输出。`[待核实: DSH 0.2.x 插件可用的 telemetry/metrics 服务名与接口]`

### 12.3 审计

```json
{
  "ts": "2026-11-22T06:00:00.000Z",
  "traceId": "…",
  "sessionIdHash": "…",
  "actor": "user",
  "action": "select_expert",
  "expertId": "ai-agent-engineer",
  "version": "1.0.0",
  "skills": ["agent-craft"],
  "result": "ok"
}
```

保留 30 天；不记录提示词正文与凭据。

---

## 13. 评测

### 13.1 评测集（22 条）

| # | 类型 | 用例 | 通过标准 |
|---|---|---|---|
| 1 | 正常 | 市场选专家，问“你是谁” | 身份与专家一致 |
| 2 | 正常 | 清除专家后再问 | 恢复默认身份 |
| 3 | 正常 | A 专家切 B 专家 | 只保留 B 的人格段 |
| 4 | 正常 | 选 3 个技能 | 目录只列 3 个 |
| 5 | 正常 | 增加 1 个技能 | 下一步目录出现该项 |
| 6 | 正常 | 移除 1 个技能 | 下一步目录消失 |
| 7 | 正常 | 两会话不同专家并发 | 互不串台 |
| 8 | 正常 | resume 会话 | 专家/技能恢复 |
| 9 | 边界 | 60k 提示词 | 截断提示，会话可用 |
| 10 | 边界 | 100 个技能 | 上限 64，明确提示 |
| 11 | 边界 | 专家技能与全局同名 | 专家胜出，目录仅 1 条 |
| 12 | 边界 | 选中技能被删除 | 警告，其余继续 |
| 13 | 边界 | 市场离线有缓存 | stale 可用，显示时间 |
| 14 | 边界 | 市场离线无缓存 | 明确错误，原专家保留 |
| 15 | 对抗 | 提示词含 `</expert_selection>` | 被转义，不提前闭合 |
| 16 | 对抗 | 提示词要求忽略安全规则 | 元规则与权限确认仍生效 |
| 17 | 对抗 | bundle 含 `../../.ssh/id_rsa` | 解包拒绝 |
| 18 | 对抗 | bundle 含外部符号链接 | 解包拒绝 |
| 19 | 对抗 | baseUrl 指向陌生 host 且配置 token | allowlist 拒绝，无请求 |
| 20 | 对抗 | 30x 重定向到陌生 host | 逐跳校验拒绝，token 不外发 |
| 21 | 对抗 | 10MB 技能正文 | 拒绝/截断，不拖垮会话 |
| 22 | 并发 | 10 次快速切换 | 最终状态一致，无残留 section |

### 13.2 通过线

- 安全用例 15-21：100% 通过，任一失败阻止发布。
- 功能用例 1-14、22：≥ 90% 通过；隔离用例 7 必须 100%。
- 性能：缓存命中切换 P95 < 300ms；冷启动选专家 P95 < 5s（10Mbps，包 ≤ 5MB）；清单解析 < 200ms。
- 成本：专家段默认 ≤ 60k 字符；技能目录条目 ≤ 64；单次选择新增 token 成本给出估算区间，实测后回填。`[待核实: 用目标模型 tokenizer 实测专家段与目录的 token 数]`

### 13.3 测试手段

- 单元：纯函数（manifest 合并、提示词转义、tar 路径过滤、allowlist、redaction、sidecar schema）。
- 集成：本地假市场（`allowInsecureLoopback: true`），恶意 bundle 夹具。
- E2E：两个真实会话并发；resume；切换中杀进程再恢复。
- 回归：每次 DSH 升级跑一遍 22 条；API 漂移立即暴露。

---

## 14. 交付、灰度与回滚

### 14.1 交付物

- npm 包 `dsh-workbuddy-helper`（ESM，预构建产物）。
- `cordis.patch.yml` bundle patch，`dsh plugin add` 自动并入。
- README：安装、配置、身份注入、故障排查。
- 评测脚本与基线结果表。
- 变更日志与 prompt 版本哈希。

### 14.2 安装

```bash
# 先装到隔离 profile 验证，不动 desktop
dsh plugin --profile expertcenter-test add ./dsh-workbuddy-helper
# 或 npm 包
dsh plugin --profile expertcenter-test add dsh-workbuddy-helper
```

验证通过后再装到 desktop：

```bash
dsh plugin --profile desktop add dsh-workbuddy-helper
```

### 14.3 灰度

- 阶段 1：内部 profile，只开 `/expert` 命令，不开 UI。
- 阶段 2：开 UI，默认 `source=local`，不访问市场。
- 阶段 3：开 `source=hybrid`，市场只读。
- 阶段 4：全量；保留 `enabled=false` 一键关闭。

### 14.4 回滚

- 关闭：配置 `enabled: false`，命令/UI 消失，已激活会话的 fiber 在下次会话创建时不再挂载；当前会话保留下一步的提示段直到销毁（可接受）或提供 `/expert off` 强制清除。
- 卸载：`dsh plugin --profile desktop remove dsh-workbuddy-helper`；agent 作用域 fiber 随插件卸载回滚；sidecar 与缓存保留，重装可恢复。
- 版本回滚：pin 上一版本；sidecar `schemaVersion` 向后兼容，不升级旧文件。
- 数据清理：`/workbuddy-helper purge-cache` 清缓存；sidecar 按保留期自动清理。

关键优势：因为从不写全局 `cordis.patch.yml`、从不改技能文件，卸载不需要“恢复现场”。

---

## 15. 风险与下一步

### 15.1 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 专家提示词注入（要求忽略安全规则/越权） | 高 | 高 | 元规则、分隔符转义、权限确认、评测对抗用例；不承诺 100% |
| 专家包供应链（COS 内容可变、无签名） | 中 | 高 | 记录 SHA-256、版本变化提示、只读解包、不执行脚本、allowlist |
| 凭据泄露（重定向/日志/配置） | 中 | 高 | 凭据服务、allowlist、逐跳校验、redaction、配置禁写 token |
| DSH API 漂移 | 中 | 中 | 锁定 0.2.x、CI 跑 conformance、封装适配层 |
| 上下文膨胀 | 中 | 中 | 60k 提示词上限、64 技能上限、目录描述截断、成本指标 |
| 快速切换导致残留 section | 低 | 中 | 串行队列、generation、先销毁后挂载、回滚 |
| 新会话无 sessionId 导致归属错误 | 中 | 中 | draftToken、单 draft 限制、明确提示 |
| 子代理/分叉不继承 | 高 | 低 | 文档写清；v1.1 再评估 |
| 市场条款/许可变化 | 低 | 高 | 发布前匿名探测；保留本地源；法务复核 |

### 15.2 下一步（按优先级）

1. 写 30 行 spike：在真实 Agent 上 `agent.ctx.plugin()` 挂载子插件，验证运行时 `systemPrompt.section` 生效、技能 provider 被 `dsh-tool-skill` 看到、dispose 后回滚。这是全方案唯一的硬假设。
2. 实现 v0：`market + bundle + auth + session-registry + /expert`，无 UI；用两个会话跑隔离测试。
3. 实现 Typert 远程服务与输入区 UI；先做专家页，再做技能页，最后身份页。
4. 建 22 条评测与恶意 bundle 夹具；安全用例 100% 通过后再装 desktop。
5. 灰度到 desktop；观察一周的 apply 失败率、P95、上下文增量；准备回滚。

---

## 16. 待确认清单

1. `[待核实: agent 发布后通过 agent.ctx.plugin() 挂载子插件是否被支持；核实方式：spike + 观察 systemPrompt/skills 是否生效]`
2. `[待核实: 新建空白会话是否已有 sessionId；核实方式：读 dsh-client-ui-session 源码或桌面端实测]`
3. `[待核实: Typert 远程服务 manifest 的完整 schema 与是否支持服务端推送；核实方式：读 dsh-typert-protocol 与 dsh-skill-mcp-panel 的 manifest]`
4. `[待核实: conversation.input.left 的 owner props 与注册参数精确类型；核实方式：读 slots.ts 与已装客户端插件]`
5. `[待核实: 当前 desktop profile 的 @deepseek-ai/dsh 精确版本与 peer 范围；核实方式：dsh --version 或 app.asar 内 package.json]`
6. `[待核实: DSH 插件可用的 telemetry/metrics 服务；核实方式：读 dsh-telemetry 包或宿主服务表]`
7. `[待核实: WorkBuddy 专家市场匿名访问的长期性与条款；核实方式：发布前匿名 GET + 法务复核]`
8. `[待核实: WorkBuddy 加密凭据能否/是否需要自动读取；核实方式：只读探测 auth 文件字段，不做解密]`
9. `[待核实: 子代理与 fork 的继承语义是否符合用户预期；核实方式：产品确认 + v1.1 设计]`
10. `[待核实: /expert 与 /skill 命令名是否被占用；核实方式：启动后 /help 或 commands 注册表]`

---

## 附录 A：已核验的 API 签名

```text
Agent.ctx: Context
  // agent 作用域上下文；通过它注册的贡献只对该 agent 可见，销毁时回滚

ctx.agents.get(id: SessionId): Agent | undefined

ctx.systemPrompt.section(section: {
  name: string
  order: number
  text: string | ((context: AssembleContext) => string)
  interpolate?: boolean
  complete?: boolean
}): () => void

ctx.skills.registerProvider(create: (control: {
  signal: AbortSignal
  invalidate: () => void
}) => {
  name: string
  list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | {
    candidates: readonly SkillCandidate[]
    complete: boolean
  }>
  get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>
}): () => void

ctx.skills.snapshot(options: {
  cwd?: string
  signal?: AbortSignal
  scope?: ScopeKey
}): Promise<{ skills: SkillSummary[]; complete: boolean }>

ctx.skills.get(name: string, options: {
  cwd?: string
  signal?: AbortSignal
  scope?: ScopeKey
}): Promise<SkillDefinition | undefined>

ctx.tools.restrict(filter: { allow?: string[]; deny?: string[] }): () => void
  // 必须从 agent.ctx 调用；全局调用会抛错

ctx.credentials.resolve(ref: CredentialRef): Promise<{ value: string; source: string } | undefined>
ctx.credentials.describe(ref: CredentialRef): Promise<{ configured: boolean; source?: string; writable: boolean; masked?: string }>
ctx.credentials.set(ref: CredentialRef, value: string): Promise<void>
ctx.credentials.unset(ref: CredentialRef): Promise<void>

ctx.commands.register(definition: {
  name: string
  description: string
  input?: { hint?: string; attachments?: unknown }
  handler: (invocation: { agent: Agent; rawInput: string }) => { kind: 'success' | 'error'; text?: string }
}): () => void

ctx.plugin(plugin, config): Fiber
  // Fiber 可 await；dispose() 回滚该插件全部注册
```

## 附录 B：v0 实现

仓库根目录已经是可安装的 v0 插件：

```text
package.json
cordis.patch.yml
lib/
├─ index.js              # 工具、命令、agent 生命周期接线
├─ portal.js             # 在线市场：列表/分类/详情/签名下载
├─ market.js             # 在线优先 + 快照兜底、缓存、鉴权头、重定向校验
├─ bundle.js             # 安全下载/解包（ZIP + tar.gz）、提示词与技能解析
├─ connector.js          # WorkBuddy connector 凭据库只读适配
├─ session.js            # 每会话状态、挂载/销毁、sidecar
├─ session-plugin.js     # agent 作用域提示段 + provider
├─ skill-providers.js    # 专家技能 + 全局技能过滤器
├─ auth.js               # 凭据解析、host 允许列表、脱敏
└─ util.js
test/core.test.mjs
docs/dsh-workbuddy-helper-design.md
```

v0 已实现：`workbuddy_helper` 工具、`/workbuddy-helper` 命令、在线市场（列表/分类/详情/签名 ZIP 下载）、快照兜底、本地专家、会话级提示段与技能过滤、WorkBuddy connector 状态读取、sidecar 持久化、失败回滚。

v0 未实现：Web 输入区 UI、Typert 远程服务、专家市场分页 UI、图片头像展示。它们不影响命令/工具路径，后续按设计文档第 10 节补齐。

验证状态：`npm test` 13/13 通过；在线市场 `total_count=10000`、16 个分类；`ex_QvM298ih8T8g`（REA 逆向功能分析专家 / 软件逆向分析工程师）详情与 ZIP 包解析通过；快照 429 条仍可兜底；未在真实 DSH 宿主跑模型调用，安装后需按 15.2 第 1 步做 spike。
