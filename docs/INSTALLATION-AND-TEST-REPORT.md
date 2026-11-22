# dsh-workbuddy-helper 迁移、安装方式与专家数据核查报告

- 日期：2026-11-22
- 新仓库：`git@github.com:awswt/dsh-workbuddy-helper.git`
- 分支：`main`
- 迁移代码提交：`44f88d9`
- 宿主：DeepSeek Harness `0.2.2-rc.5`

---

## 1. 三项任务结论

| 任务 | 结论 |
|---|---|
| 1. 迁移到新仓库并改名 | 已完成。包名、bundle id、工具、命令、prompt 段、provider、数据目录、文档全部改为 `dsh-workbuddy-helper` / `workbuddy_helper` / `/workbuddy-helper` |
| 2. 判断并改造安装方式 | 当前 `git+ssh://...` 命令可用，但不是标准用户安装方式。标准方式应是 npm 包 `dsh-workbuddy-helper`；本机无 npm 发布凭据，已准备并验证 tarball 安装，npm 发布后的一行命令已写入 README |
| 3. 专家数量与逆向专家核查 | 公开市场清单确为 429 个唯一专家、15 个分类；“软件逆向分析工程师”不在公开 429 条中，但本机 WorkBuddy 已安装专家 `rea-reverse-engineer` 的 profession 正是该名称，插件已能搜索并选择它 |

---

## 2. 迁移与改名

### 2.1 仓库

```text
old: git@github.com:awswt/dsh-onversation-help.git
new: git@github.com:awswt/dsh-workbuddy-helper.git
```

新仓库已推送 `main`，旧仓库保留为 `old-origin` remote，未删除历史。

### 2.2 命名映射

| 位置 | 修改前 | 修改后 |
|---|---|---|
| npm 包名 | `dsh-onversation-help` | `dsh-workbuddy-helper` |
| bundle 行 id | `onversation-help` | `workbuddy-helper` |
| 工具 | `onversation_help` | `workbuddy_helper` |
| 命令 | `/onversation-help` | `/workbuddy-helper` |
| 专家提示段 | `onversation-help:expert:<gen>` | `workbuddy-helper:expert:<gen>` |
| 技能范围段 | `onversation-help:skill-scope:<gen>` | `workbuddy-helper:skill-scope:<gen>` |
| 专家技能 provider | `onversation-help-expert-<gen>` | `workbuddy-helper-expert-<gen>` |
| 全局技能过滤 provider | `onversation-help-filter-<gen>` | `workbuddy-helper-filter-<gen>` |
| 错误码 | `ONVERSATION_HELP_*` | `WORKBUDDY_HELPER_*` |
| 数据目录 | `$DSH_HOME/onversation-help` | `$DSH_HOME/workbuddy-helper` |
| 设计文档 | `docs/dsh-onversation-help-design.md` | `docs/dsh-workbuddy-helper-design.md` |

旧数据目录已复制到新目录，旧目录保留未删除：

```bash
cp -r ~/.dsh/onversation-help ~/.dsh/workbuddy-helper
```

新代码对旧 sidecar 中 `displayName` 为对象的情况做了兼容，恢复时统一转字符串。

---

## 3. 安装命令判断与改造

### 3.1 当前命令是否正确

```bash
dsh plugin --profile <profile> add git+ssh://git@github.com/awswt/dsh-onversation-help.git
```

结论：**技术上可用，但不适合作为面向他人的标准安装方式。**

原因：

1. 要求使用者本机配置 GitHub SSH key；
2. 要求安装 Git 与 pnpm 的 Git 依赖构建链；
3. 安装的是源码仓库，不是带版本号的发布产物；
4. 无法用 npm semver 约束版本，也无法走 npm 镜像/缓存；
5. 仓库改名后旧命令已经失效。

它适合开发者拉最新源码，不适合最终用户。

### 3.2 标准安装方式

截图里的形式：

```bash
dsh plugin --profile web add dsh-expert-market
```

这是 npm 包名安装方式。对本项目，标准命令应为：

```bash
dsh plugin --profile <profile> add dsh-workbuddy-helper
```

前置条件是包已发布到 npm。当前机器：

```text
npm whoami -> ENEEDAUTH
registry.npmmirror.com/dsh-workbuddy-helper -> 404
```

因此本次**没有执行 `npm publish`**，也不能声称 npm 命令现在已可用。仓库已补齐：

- `files` 白名单；
- `publishConfig.access = public`；
- `repository` / `homepage`；
- `npm pack` 产物 `dist/dsh-workbuddy-helper-0.1.0.tgz`；
- tarball 安装实测。

维护者完成一次：

```bash
npm login
npm publish
```

之后其他人即可使用：

```bash
dsh plugin --profile <profile> add dsh-workbuddy-helper
```

### 3.3 当前可用的无 GitHub 安装方式

离线 tarball：

```bash
npm pack
dsh plugin --profile <profile> add /absolute/path/to/dsh-workbuddy-helper-0.1.0.tgz
```

或把 tarball 放到任意 HTTPS 静态地址：

```bash
dsh plugin --profile <profile> add https://your-cdn.example.com/dsh-workbuddy-helper-0.1.0.tgz
```

已验证：

- tarball 大小 47.8 kB；
- 安装到全新 profile `workbuddy-helper-tgz2`；
- 依赖解析为 `dsh-workbuddy-helper file:E:/.../dsh-workbuddy-helper-0.1.0.tgz`；
- `--dump-config` 退出码 0，组合中出现 `dsh-workbuddy-helper` bundle 行；
- 假模型端到端执行 `workbuddy_helper(action="connector")` 成功。

---

## 4. 专家数量与“软件逆向分析工程师”核查

### 4.1 公开市场清单

来源：

```text
https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace/expert_center.json
```

本次重新拉取结果：

| 项 | 值 |
|---|---|
| HTTP | 200 |
| 字节数 | 1,158,100 |
| manifest version | `1.0.0` |
| lastUpdated | `2026-08-18T03:00:00Z` |
| experts 数组长度 | 429 |
| 唯一 id 数 | 429 |
| 重复 id | 0 |
| categories | 15 |

所以“429 个”是准确的，且不是重复计数。

### 4.2 公开市场是否有“软件逆向分析工程师”

对 429 条逐条搜索：

| 关键词 | 命中数 |
|---|---:|
| `软件逆向分析工程师` | 0 |
| `逆向分析` | 0 |
| `软件逆向` | 0 |
| `逆向工程` | 0 |
| `reverse-engineer` | 0 |
| `reverse engineer` | 0 |

结论：**公开 `expert_center.json` 的 429 条中没有“软件逆向分析工程师”。**

### 4.3 为什么 WorkBuddy 里能看到

本机 WorkBuddy 已安装专家：

```text
~/.workbuddy/plugins/marketplaces/experts/plugins/rea-reverse-engineer
```

其 `.codebuddy-plugin/plugin.json`：

```json
{
  "name": "rea-reverse-engineer",
  "version": "1.0.0",
  "displayName": { "zh": "REA 逆向功能分析专家", "en": "REA Reverse Engineer Anything Expert" },
  "profession": { "zh": "软件逆向分析工程师", "en": "Software Reverse Engineering Analyst" },
  "author": { "name": "mdit-lu", "email": "mdit-lu@example.com" },
  "skills": ["./skills/rea-analysis"]
}
```

安装时间：`2026-11-04T15:07:37.349Z`。

WorkBuddy 的本地专家映射：

```text
~/.workbuddy/app/cache/experts/expert-bundle-map.json
ex_QvM298ih8T8g -> rea-reverse-engineer
```

这说明你看到的是 WorkBuddy 的**已安装/自定义专家**，不是公开市场清单里的 429 条之一。它在 WorkBuddy UI 的“已安装/我的专家”区域可见，因此与“公开市场 429 条”并不矛盾。

### 4.4 插件是否能看到并选中它

已把本地专家合并进 `workbuddy_helper` 的 `market` 搜索：

- 公开清单仍统计 429；
- 本机专家统计 8；
- `market query="逆向"` 会返回 `rea-reverse-engineer`，`source=local`；
- `expert expertId="rea-reverse-engineer"` 可直接选中；
- 技能为 `rea-analysis`。

宿主接线实测输出：

```json
{
  "market": {
    "publicTotal": 429,
    "localTotal": 8,
    "reverseFound": true
  },
  "reverseExpert": "REA 逆向功能分析专家",
  "selectedExpert": "ai-agent-engineer",
  "selectedSkills": ["agent-craft"],
  "cleared": true,
  "fiberDisposed": 2
}
```

所以数据差异已解释清楚：**公开市场 429 条不含它；本机已安装专家包含它；插件现在两者都能看到。**

---

## 5. 测试过程与结果

### 5.1 单元测试

```bash
npm test
```

结果：8/8 通过。覆盖提示词转义、HTTPS/host 允许列表、内联密钥拒绝、connector 只读解析、市场缓存与认证头、本地专家列表与解析、路径穿越。

### 5.2 宿主接线测试

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
  "market": { "publicTotal": 429, "localTotal": 8, "reverseFound": true },
  "reverseExpert": "REA 逆向功能分析专家",
  "cleared": true,
  "fiberDisposed": 2
}
```

覆盖：工具/命令注册、connector 查询、市场 + 本地合并搜索、两个专家连续切换、技能列表、`off` 清理、fiber 销毁。

### 5.3 全新 profile 的 tarball 安装

```bash
dsh --profile workbuddy-helper-tgz2 --from-default-profile headless --dump-config
dsh plugin --profile workbuddy-helper-tgz2 add \
  E:/DSH/workspace/migrate/dist/dsh-workbuddy-helper-0.1.0.tgz（本地产物，未提交）
dsh --profile workbuddy-helper-tgz2 --dump-config | grep -A 4 workbuddy-helper
```

结果：

```yaml
- id: workbuddy-helper
  name: dsh-workbuddy-helper
  config:
    enabled: true
    authMode: none
```

假模型端到端：

```text
EXIT 0
STDOUT: CONNECTOR_TOOL_OK
tool_result: installed=true, version=5.30.0, accountCount=3, usableAccountCount=3, tokenAvailable=true
```

这证明 tarball 安装路径不依赖 GitHub，且插件在真实 DSH 中可执行。

### 5.4 新 GitHub 仓库安装验证

```bash
dsh --profile workbuddy-helper-gh --from-default-profile headless --dump-config
dsh plugin --profile workbuddy-helper-gh add \
  git+ssh://git@github.com/awswt/dsh-workbuddy-helper.git
dsh --profile workbuddy-helper-gh --dump-config | grep -A 4 workbuddy-helper
```

结果：

- 依赖解析为 `github:awswt/dsh-workbuddy-helper`；
- `--dump-config` 退出码 0；
- 组合中出现 `id: workbuddy-helper` / `name: dsh-workbuddy-helper`；
- 假模型专家端到端：请求体积 318,626 → 349,354 字节，含 `<expert_selection>`、显示名“程枢”、技能目录含 `agent-craft`，无 `[object Object]`，退出码 0。

### 5.5 真实模型

未执行真实模型调用：headless profile 没有 `DEEPSEEK_API_KEY`，启动会在模型前报 `MISSING_CREDENTIAL`。本次用本地 Messages 兼容假模型验证了工具管线、专家提示段与技能目录，不消耗真实额度。

---

## 6. 本次修复的问题

| 问题 | 修复 |
|---|---|
| 包名/仓库/命令仍为旧名 | 全量替换为 `dsh-workbuddy-helper`、`workbuddy_helper`、`/workbuddy-helper` |
| `market` 只查公开清单，看不到本机逆向专家 | 新增 `BundleStore.listLocal()`，`market` 合并公开 + 本地，结果带 `source` |
| 旧 sidecar 的 `displayName` 是对象 | `normalizeState` 统一转字符串，兼容旧数据 |
| 安装方式依赖 GitHub | 增加 `files`/`publishConfig`/`repository`，准备 npm 发布与 tarball 安装，并实测 tarball |
| npm 包尚未发布 | 本机无 npm 凭据，README 明确写出发布步骤与当前可用替代方案 |

---

## 7. 限制与后续

1. **npm 发布未执行**：需要 `npm login` + `npm publish`；当前他人可用 tarball，不能用 npm 短命令。
2. **没有 Web UI**：仍是工具 + 命令形态。
3. **公开市场 vs 本地专家**：`market` 现在会同时返回两者，UI 需用 `source` 区分；公开总数固定 429，本地数量随安装变化。
4. **逆向专家来源**：本机 `rea-reverse-engineer` 不是公开 429 条的一部分；如果 WorkBuddy 把它显示在“市场”而非“已安装”，那是 WorkBuddy 自己的分类语义，公开清单数据本身不含它。
5. **真实模型未测**：人格服从度、真实 token 成本需配置 API key 后补测。

---

## 8. 仓库与提交

```text
git@github.com:awswt/dsh-workbuddy-helper.git
main
44f88d9 refactor: rename to dsh-workbuddy-helper and merge local experts into market search
docs: rewrite migration and verification report（本报告提交见 main 最新提交）
```

旧仓库保留：

```text
old-origin git@github.com:awswt/dsh-onversation-help.git
```

关键文件：

```text
lib/index.js
lib/session.js
lib/session-plugin.js
lib/skill-providers.js
lib/market.js
lib/bundle.js
lib/connector.js
lib/auth.js
lib/util.js
test/core.test.mjs
test/host-integration.mjs
dist/dsh-workbuddy-helper-0.1.0.tgz（本地产物，未提交）
docs/dsh-workbuddy-helper-design.md
docs/INSTALLATION-AND-TEST-REPORT.md
```
