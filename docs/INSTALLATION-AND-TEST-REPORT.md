# dsh-workbuddy-helper 改造、接入与测试报告

- 日期：2026-11-22
- 仓库：`git@github.com:awswt/dsh-workbuddy-helper.git`
- 分支：`main`
- 代码提交：`bcafcfa`；本报告随后提交在 `main`
- 宿主：DeepSeek Harness `0.2.2-rc.5`，测试 profile `workbuddy-helper-gh`（headless 组合）

---

## 1. 交付摘要

| 项 | 结果 |
|---|---|
| 插件改名 | 完成，统一为 `dsh-workbuddy-helper`（按用户指定保留 `onversation` 拼写） |
| WorkBuddy connector 接入 | 完成，只读复用 `dsh-connect-workbuddy` 账号库，提供 `connector` 状态与 `workbuddy-connector` 认证模式 |
| 会话级专家/技能 | 完成，`agent.ctx` 子插件 + 两个技能 provider + sidecar |
| 代码推送 | 完成，已推送到 `main`（代码提交 `bcafcfa`） |
| GitHub 安装 | 完成，`workbuddy-helper-gh` profile 从 `git+ssh://git@github.com/awswt/dsh-workbuddy-helper.git` 安装成功 |
| 单元测试 | 8/8 通过 |
| 宿主接线测试 | 通过（工具、命令、专家选择、技能、清理、fiber 销毁） |
| 假模型端到端 | 通过（真实 DSH 宿主执行 `workbuddy_helper`，专家提示段与技能目录注入生效） |
| 真实模型端到端 | 未执行：headless profile 缺少 `DEEPSEEK_API_KEY`，不消耗用户真实额度 |

---

## 2. 命名修改

| 位置 | 修改前 | 修改后 |
|---|---|---|
| npm 包名 | `dsh-expert-center` | `dsh-workbuddy-helper` |
| bundle 行 id | `expert-center` | `workbuddy-helper` |
| prompt 段 | `expert-center:expert` | `workbuddy-helper:expert:<gen>` |
| 技能范围段 | `expert-center:skill-scope` | `workbuddy-helper:skill-scope:<gen>` |
| 专家技能 provider | `expert-bundle` | `workbuddy-helper-expert-<gen>` |
| 全局技能过滤 provider | `expert-session-filter` | `workbuddy-helper-filter-<gen>` |
| 工具名 | 无 | `workbuddy_helper` |
| 命令名 | 无 | `/workbuddy-helper` |
| 错误码前缀 | `EXPERT_CENTER_` | `WORKBUDDY_HELPER_` |
| 数据目录 | `$DSH_HOME/expert-center` | `$DSH_HOME/workbuddy-helper` |
| 设计文档 | `docs/dsh-expert-center-design.md` | `docs/dsh-workbuddy-helper-design.md` |

`<gen>` 是每次挂载递增的 generation，用于“先挂新、再销毁旧”，切换失败时保留旧人格。

---

## 3. WorkBuddy connector 接入方式

### 3.1 接入点

不复制 `dsh-connect-workbuddy` 的模型路由/账号池逻辑，只读它的账号库：

```text
$DSH_HOME/workbuddy-vault/<region>/<accountId>.json
```

支持 `cn`、`global` 与 legacy 根目录三种布局。读取字段：

- `accountId`
- `account.nickname`
- `auth.accessToken`
- `auth.expiresAt`

`expiresAt` 在 vault 中是 Unix 秒；适配层统一转毫秒，避免把 2026 年账号误判成 1970 年过期。

### 3.2 检测

按 `$DSH_HOME/profiles/*/node_modules/dsh-connect-workbuddy/package.json` 探测安装位置与版本。当前机器结果：

```json
{
  "connector": "dsh-connect-workbuddy",
  "installed": true,
  "profile": "desktop",
  "version": "5.30.0",
  "vaultPresent": true,
  "accountCount": 3,
  "usableAccountCount": 3,
  "tokenAvailable": true,
  "regions": ["cn", "global"]
}
```

账号 id 与昵称做掩码；`status()` 不返回 token。

### 3.3 两种认证模式

```yaml
# 默认：公开市场匿名访问
authMode: none

# 可选：企业网关/需要鉴权的市场
authMode: workbuddy-connector
allowHosts:
  - your-enterprise-gateway.example.com
marketBaseUrl: https://your-enterprise-gateway.example.com/workbuddy/expert-marketplace

# 或使用 DSH 凭据服务
authMode: bearer
credentialRef: WB_EXPERT_TOKEN
```

安全约束：

- 默认 `authMode: none`：公开 COS 市场不需要 token，避免把 WorkBuddy 凭据发给公共桶。
- `authMode: workbuddy-connector` 且 `marketBaseUrl` 指向公开市场 host 时，默认拒绝启动；只有显式 `allowPublicMarketAuth: true` 才允许。
- token 只发往 `allowHosts` 的 HTTPS host；重定向逐跳校验；头像等静态资源不带凭据。
- `status()`、日志、错误文案只出现掩码账号与 `credentialRef`，不出现 token。

---

## 4. 实现内容

### 4.1 文件

| 文件 | 内容 |
|---|---|
| `lib/index.js` | `workbuddy_helper` 工具、`/workbuddy-helper` 命令、agent 生命周期、配置装配 |
| `lib/session.js` | 每会话状态、串行队列、挂载/销毁、失败回滚、sidecar |
| `lib/session-plugin.js` | `agent.ctx` 内注册专家提示段与技能 provider |
| `lib/skill-providers.js` | 专家技能 provider + 全局技能影子过滤器 |
| `lib/market.js` | WorkBuddy 市场清单、缓存、重试、重定向、认证头 |
| `lib/bundle.js` | tar.gz 下载、安全解包、plugin.json/提示词/技能解析 |
| `lib/connector.js` | WorkBuddy connector 账号库只读适配 |
| `lib/auth.js` | 凭据解析、HTTPS/host 允许列表、脱敏 |
| `lib/util.js` | 路径安全、原子写、哈希、截断 |
| `test/core.test.mjs` | 8 条单元测试 |
| `test/host-integration.mjs` | 宿主接线集成测试（假 ctx） |
| `test/fake-model-e2e.mjs` | 真实 DSH + 假模型：`connector` 工具端到端 |
| `test/fake-model-expert-e2e.mjs` | 真实 DSH + 假模型：`expert` 选择端到端 |

### 4.2 会话隔离

1. 选择专家时，在 `agent.ctx` 下挂载子插件。
2. 子插件注册：
   - `workbuddy-helper:expert:<gen>` 系统提示段；
   - `workbuddy-helper-expert-<gen>` 专家技能 provider（rank 200）；
   - `workbuddy-helper-filter-<gen>` 全局技能影子 provider（rank 1000，仅 `globalMode=selected` 时）。
3. 新 fiber 挂载成功后才销毁旧 fiber；挂载失败时旧人格保留。
4. 状态写 `$DSH_HOME/workbuddy-helper/sessions/<sha256(sessionId)>.json`；`agent/created` 重放，插件启动时 `ctx.agents.list()` 对账。
5. 技能开关变化只改内存 state 并调用 provider 的 `invalidate()`；不重挂、不写全局技能文件。

### 4.3 专家包安全

- 只允许 `.codebuddy-plugin/`、`.workbuddy-plugin/`、`agents/`、`skills/`、`avatars/`、`license/`、`README.md`。
- 拒绝绝对路径、`..`、符号链接/硬链接；限制 2000 条目、50MB 解压体积。
- 只读 markdown/资源，不执行脚本、不 `npm install`。
- 专家提示词用 `<expert_selection>` 包裹，转义闭合标签，并声明不得覆盖安全规则、工具权限与危险操作确认。

---

## 5. 安装步骤

### 5.1 前置

- DSH `0.2.2-rc.5` 或兼容的 `0.2.x`
- 本机已配置 GitHub SSH
- 已安装 `dsh-connect-workbuddy`（可选；没有它仍可使用公开市场与手动凭据）

### 5.2 创建隔离测试 profile

```bash
dsh --profile workbuddy-helper-gh --from-default-profile headless --dump-config
```

### 5.3 从 GitHub 安装

```bash
dsh plugin --profile workbuddy-helper-gh add \
  git+ssh://git@github.com/awswt/dsh-workbuddy-helper.git
```

HTTPS 等价写法：

```bash
dsh plugin --profile workbuddy-helper-gh add \
  https://github.com/awswt/dsh-workbuddy-helper.git
```

### 5.4 验证安装

```bash
dsh --profile workbuddy-helper-gh --dump-config | grep -A 4 workbuddy-helper
```

期望：

```yaml
# == dsh-workbuddy-helper
- id: workbuddy-helper
  name: dsh-workbuddy-helper
  config:
    enabled: true
    authMode: none
```

### 5.5 配置示例

```yaml
- insert:
    - id: workbuddy-helper
      name: dsh-workbuddy-helper
      config:
        enabled: true
        authMode: none
        maxPromptChars: 60000
        maxSelectedSkills: 64
```

---

## 6. 测试过程与结果

### 6.1 单元测试

命令：

```bash
npm test
```

结果：8/8 通过。

覆盖：

1. `renderExpertBlock` 转义 `</expert_selection>`、移除 NUL；
2. HTTPS/host 允许列表；
3. `none` / 内联密钥拒绝 / `workbuddy-connector` 认证；
4. connector 无可用 token 的错误；
5. connector vault 只读解析、秒级过期时间、status 不泄漏 token；
6. 市场清单、缓存、认证头；
7. 本地专家解析与路径逃逸技能跳过；
8. `safeJoin` 路径穿越。

### 6.2 真实市场

| 项 | 结果 |
|---|---|
| manifest URL | `.../workbuddy/expert-marketplace/expert_center.json` |
| HTTP | 200 |
| 字节数 | 1,158,100 |
| 专家数 | 429 |
| 分类数 | 15 |
| `ContentCreator` bundle | 200，677,238 字节 |
| 解析结果 | plugin version `1.0.1`，5 个技能：`anti-distill / humanizer / minimax-docx / novel-writer / novel-writing` |

### 6.3 本机专家

| 项 | 结果 |
|---|---|
| 专家 | `ai-agent-engineer` |
| 来源 | 本地 `~/.workbuddy/plugins/marketplaces/experts/plugins/ai-agent-engineer` |
| 版本 | `1.0.0` |
| 提示词 | 5,705 字符 |
| 技能 | `agent-craft` |

### 6.4 宿主接线集成测试

命令：

```bash
NODE_PATH="D:/Program Files/deepseek harness/resources/app.asar/dsh/node_modules" \
ELECTRON_RUN_AS_NODE=1 "D:/Program Files/deepseek harness/DeepSeek Harness.exe" \
test/host-integration.mjs
```

结果：

```json
{
  "ok": true,
  "tool": "workbuddy_helper",
  "command": "workbuddy-helper",
  "connector": { "installed": true, "accounts": 3, "usable": 3 },
  "selectedExpert": "ai-agent-engineer",
  "selectedSkills": ["agent-craft"],
  "cleared": true,
  "fiberDisposed": 1
}
```

覆盖：工具注册、命令注册、connector 查询、专家选择、专家提示段注册、专家技能 provider、技能列表、`off` 清理、fiber 销毁。

### 6.5 GitHub 安装验证

- profile：`workbuddy-helper-gh`
- 依赖：`dsh-workbuddy-helper: github:awswt/dsh-workbuddy-helper`
- `dsh --dump-config` 退出码 0
- 组合中出现 bundle 行 `workbuddy-helper`
- 安装副本中 `lib/session.js` 已包含最新显示名修复

### 6.6 真实 DSH headless 启动

命令：

```bash
dsh --profile workbuddy-helper-gh "Use the workbuddy_helper tool with action=connector."
```

结果：

- 插件激活，未出现在 pending/未激活列表；
- 宿主在模型前止于 `MISSING_CREDENTIAL`（headless profile 没有 `DEEPSEEK_API_KEY`）；
- 该错误与插件无关；未使用真实模型额度。

stderr 中仅有 `preset-maoying` 等 6 条与插件无关的 pending 警告。

### 6.7 假模型端到端：connector 工具

本地 Messages 兼容 SSE 服务冒充模型返回：

```json
{"name":"workbuddy_helper","input":{"action":"connector"}}
```

真实 DSH 执行工具后，第二次请求带回 `tool_result`，内容为：

```json
{
  "connector": "dsh-connect-workbuddy",
  "installed": true,
  "profile": "desktop",
  "version": "5.30.0",
  "vaultPresent": true,
  "accountCount": 3,
  "usableAccountCount": 3,
  "tokenAvailable": true,
  "regions": ["cn", "global"],
  "accounts": [
    { "accountId": "0058…1110", "region": "cn", "expired": false, "hasToken": true },
    { "accountId": "91cc…0203", "region": "global", "expired": false, "hasToken": true },
    { "accountId": "a8b4…162e", "region": "global", "expired": false, "hasToken": true }
  ]
}
```

最终输出 `CONNECTOR_TOOL_OK`，退出码 0。证明工具在真实 DSH 工具管线中可执行，且 connector 状态正确、token 未出现在结果中。

### 6.8 假模型端到端：专家选择

本地假模型返回：

```json
{"name":"workbuddy_helper","input":{"action":"expert","expertId":"ai-agent-engineer"}}
```

真实 DSH 执行后，下一次模型请求：

| 指标 | 结果 |
|---|---|
| 工具调用前请求体积 | 316,456 字节 |
| 工具调用后请求体积 | 345,056 字节（+28,600） |
| 含 `<expert_selection>` | true |
| 含专家显示名“程枢” | true |
| 含 `[object Object]` | false |
| 最新技能目录含 `agent-craft` | true |
| 技能目录含 `xlsx` | false（headless 全局目录本来没有它） |
| 最终输出 | `EXPERT_TOOL_OK` |
| 退出码 | 0 |

证明：专家提示段已注入真实 system prompt，专家技能已进入真实技能目录，且未污染其他技能。

### 6.9 发现并修复的问题

| 问题 | 现象 | 修复 |
|---|---|---|
| 市场 URL 拼接丢失路径 | `new URL('/expert_center.json', baseUrl)` 丢掉 `/workbuddy/expert-marketplace`，返回 403 | 改为显式 `joinUrl(base, path)` |
| tar 解包白名单漏掉插件清单目录 | 解包后找不到 `.codebuddy-plugin/plugin.json` | 白名单加入 `.codebuddy-plugin/`、`.workbuddy-plugin/` |
| connector `expiresAt` 单位 | 秒被当毫秒，账号显示 1970 年已过期 | 小于 `1e12` 的值按秒转毫秒 |
| 本地专家不在市场清单 | `ai-agent-engineer` 无法通过市场查找 | `resolveExpert` 失败后回退本地 bundle |
| 专家显示名是对象 | 提示词出现 `[object Object]` | 统一取 `zh`/`en` 字符串 |
| `Object.assign` 改函数 name 抛错 | 早期参考实现导出插件失败 | 改为函数包装 + `plugin.inject` |
| connector token 误发风险 | 用户把 `authMode` 改成 connector 时可能把 token 发给公开 COS | 默认拒绝公开 host，需显式 `allowPublicMarketAuth: true` |

---

## 7. 限制与风险

1. **没有 Web UI**：当前提供工具与斜杠命令，输入区“+”菜单/选择器尚未实现；设计文档第 10 节已给出插槽与 RPC 契约。
2. **真实模型未跑**：headless profile 没有 `DEEPSEEK_API_KEY`；端到端用本地假模型验证了工具/提示/技能管线，未验证真实模型对专家人格的服从度。
3. **公开市场匿名**：当前可用，但不构成长期契约；市场若改为鉴权，需配置 `authMode`。
4. **connector 只读**：不刷新 token、不写 vault；token 过期时需要用户在 WorkBuddy connector 中重新登录。
5. **单专家**：每会话最多 1 个专家；子代理与 fork 默认不继承。
6. **提示注入**：专家包内容不可信；已做分隔符转义、元规则与权限确认，但不能承诺 100% 免疫。
7. **peer 依赖警告**：`pnpm` 提示 peer 依赖问题，不影响加载；`@deepseek-ai/dsh` 由宿主提供。

---

## 8. 复现命令

```bash
# 1. 运行单元测试
cd dsh-workbuddy-helper
npm install
npm test

# 2. 创建测试 profile
dsh --profile workbuddy-helper-gh --from-default-profile headless --dump-config

# 3. 从 GitHub 安装
dsh plugin --profile workbuddy-helper-gh add \
  git+ssh://git@github.com/awswt/dsh-workbuddy-helper.git

# 4. 验证组合
dsh --profile workbuddy-helper-gh --dump-config | grep -A 4 workbuddy-helper

# 5. 宿主接线测试
NODE_PATH="<DSH app.asar>/dsh/node_modules" \
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" test/host-integration.mjs

# 6. 假模型端到端
DSH_APP_EXE="<DeepSeek Harness.exe>" \
DSH_BIN="<DSH app.asar>/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
DSH_TEST_PROFILE=workbuddy-helper-gh \
node test/fake-model-expert-e2e.mjs
```

---

## 9. 仓库信息

```text
git@github.com:awswt/dsh-workbuddy-helper.git
main
bcafcfa fix: fall back to manifest display name when bundle metadata is absent
320715d docs: add installation and test report
7a20293 fix: refuse connector token on the public market host by default
be5b19b fix: resolve expert display name from bundle metadata
4110b90 fix: store expert display name as a string; add fake-model e2e probes
4ec7323 feat: add session-scoped experts, skills and WorkBuddy connector bridge
```

工作区：`E:/DSH/workspace/migrate`
测试 profile：`~/.dsh/profiles/workbuddy-helper-gh`
数据目录：`~/.dsh/workbuddy-helper`
