# 自己登录 WorkBuddy，不再依赖 dsh-connect-workbuddy

本文记录「本插件内嵌 WorkBuddy 登录」这件事的**实测依据**、实现结构，以及两层依赖到底是怎么回事。

先说结论：

| 问题 | 答案 |
|---|---|
| 能自己登录吗 | 能。三个 https 端点，扫码登录，token 存进本插件自己的账号库 |
| 还需要 `dsh-connect-workbuddy` 吗 | 不需要。它只在「你已经有它的登录态、想搬过来」时被**只读**一次 |
| 必须在宿主机装 WorkBuddy 桌面端吗 | 不需要。本插件只发 https 请求，一次也不碰本地安装目录 |

---

## 1. 两层依赖，别混为一谈

这两个东西经常被当成一件事，其实完全独立：

### 第一层：`dsh-connect-workbuddy` 插件

它是另一个 DSH 插件（作者 dingminhua，实测版本 5.30.0）。它做了很多事（模型 provider、账号池、自动签到、ACP 通道……），
但**本插件过去只用到它的一件事**：它把登录态落在

```text
$DSH_HOME/workbuddy-vault/<region>/<accountId>.json
```

本插件读这个目录拿 `accessToken`，用于端口 `www.workbuddy.cn` 的在线市场。
所以「本插件依赖 dsh-connect-workbuddy」这个描述是准确的，但依赖面**极窄**：只有一份 json 文件。

现在这份依赖被两条路取代：

- **主路径**：本插件自己扫码登录，把 token 存进自己的库（`$DSH_HOME/workbuddy-helper/accounts/`）。
- **兼容路径**：`workbuddy_helper { action:'account', accountAction:'import' }` 一次性把旧 vault 搬过来，之后可以卸载那个插件。

旧 vault 始终是**只读**的：本插件不改它、不刷它的 token、不删它的文件。

### 第二层：WorkBuddy 桌面端（`WorkBuddy.exe`）

桌面端和本插件**没有任何文件或进程关系**。全仓库搜 `WorkBuddy.exe` / `asar` / `Program Files` 在 `lib/` 下零命中。

唯一"沾边"的是专家来源的本地目录：

```text
~/.workbuddy/plugins/marketplaces/experts/plugins
~/.workbuddy/plugins/marketplaces/my-experts
```

这两个是 `localRoots` 的默认值——**装了桌面端、且在里面装过专家**，才会有东西。
`BundleStore.listLocal()` 对读不到的 root 直接 `continue`（`lib/bundle.js:73-82`），所以目录不存在就等于"本机没有额外专家"，
不是错误、不影响任何其他功能。

一句话：**没装桌面端，专家/技能/连接器三个市场全部照常工作**，只是"本机已装专家"那一栏是空的。

---

## 2. 三个端点（实测）

区域决定 base，而且**必须在申请 state 之前定下来**：一个域名签发的 token 会被另一个域名的网关拒绝，
所以"先拿 token 再换域名"这条路不存在。

```text
国内版 cn      https://www.codebuddy.cn
国际版 global  https://www.workbuddy.ai      （www.codebuddy.ai 同属国际版）
```

### 2.1 申请登录

```http
POST {base}/v2/plugin/auth/state?platform=workbuddy
Content-Type: application/json

{}
```

实测三家 base 都返回 200：

```json
{ "code": 0, "msg": "OK", "data": {
    "state": "c48bc7c1-…",
    "authUrl": "https://www.codebuddy.cn/login?platform=workbuddy&state=c48bc7c1-…"
} }
```

`authUrl` 有时缺失，此时按 `{base}/login?platform=workbuddy&state=<encoded>` 合成。
拿到的是一个真能打开的登录页（实测 `GET` 该 URL 返回 200、22 KB HTML，国内版页面里有二维码相关字样）。

### 2.2 轮询结果

```http
GET {base}/v2/plugin/auth/token?state=<state>
```

| 情况 | 答复 |
|---|---|
| 还没扫码 | `{"code":11217,"msg":"login ing..."}`，**HTTP 200** |
| state 是瞎编的 | 同样 `11217` —— 上游不区分"没扫"和"未知"，所以本地必须自己管 state 的生死 |
| 扫码完成 | `{ code:0, data:{ accessToken, refreshToken, expiresIn, domain } }` |

`11217` 不是错误，是"继续等"。真正的失败码才终止：`12153`（token 格式错）、`12151`（未选择登录账号）、`40001` / `41001`。

### 2.3 拉账号资料

```http
GET {base}/v2/plugin/account
Authorization: Bearer <accessToken>
X-Domain: <tokenData.domain>      （有时需要）
```

实测国内版返回 23 个字段：`uid / nickname / avatarUrl / uin / type / lastLogin / isCreator / isAdmin / pluginEnabled /
deployStatus / accountType / sso / idp / areaInfoComplete / oneidAccountId / uniqueUserId / isCurrentOneIdEnterprise /
isCurrentOneIdPersonal / isFirstLogin / phoneNumber / logOutEnable …`

**旧端点 `/v2/plugin/login/account` 对任何凭据都回 `{"code":12151,"msg":"not choose login account"}`**，
所以它只能当回退，不能当主路——先问它会把每个账号都算成"未命名"，彼此覆盖。
两者都没有 `uid` 时，最后读 accessToken 自己的 JWT 声明兜底（纯展示用途，不是鉴权）。

### 2.4 刷新

```http
POST {base}/v2/plugin/auth/token/refresh
X-Refresh-Token: <refreshToken>
X-Auth-Refresh-Source: workbuddy
Origin: {base}
Referer: {base}/
User-Agent: CLI/2.63.2 CodeBuddy/2.63.2
X-Enterprise-Id: <可选>
```

**刻意不发 `Authorization`**：刷新用的就是 refresh token，同时递旧 access 只会让失败原因更难分辨。

实测四个 host（`www.codebuddy.cn`、`copilot.tencent.com`、`www.workbuddy.ai`、`www.codebuddy.ai`）上这条路由都存在，
坏 token 统一回 `401 {"code":12153,"msg":"12153:refresh token failed:10000:token format error"}` —— 不是 404，说明路由在。

---

## 3. 实现结构

```text
lib/wb-login.js      协议层。三个端点 + 刷新 + 进程内登录会话表。无 DSH import，fetch/时钟可注入。
lib/wb-vault.js      本插件自己的账号库。落盘、加锁、脱敏视图、从旧 vault 导入。
lib/wb-accounts.js   状态机。start/poll/cancel/list/refresh/remove/importLegacy，poll 成功即落盘。
lib/connector.js     分层凭据源。helper（自有库）→ vault（只读兼容）→ DSH credential。
```

### 3.1 为什么账号库不像 dsh-connect-workbuddy 那样布局

本插件存 `<dataDir>/accounts/<region>/<accountId>.json`（默认 `$DSH_HOME/workbuddy-helper/accounts/`），
**刻意与 `$DSH_HOME/workbuddy-vault` 不同**：

- 两个插件都装时互不干扰，谁也不覆盖谁的 token；
- 迁移是显式动作（`importLegacy`），不是"装了就自动抢";
- `accountIdOf(uid)` 取 `sha256(uid)` 前 24 位——同一账号重登落到同一个文件，不会越积越多；`uid` 是 36 位 UUID，
  直接当文件名既长又泄露原值。

文件权限：目录 `0700`、文件 `0600`，写入走「临时文件 + rename」原子替换，跨进程用 `<region>-<hash>` 目录锁。

### 3.2 分层顺序与"永不写 vault"

`resolveToken()` 的排序是 `source=helper` 优先，**即使它更早过期**——因为那份才是我们能刷新的。
vault 的票只有 5 小时也可能比自有票晚过期，但它刷新不了，优先用它等于把流程卡在一个必死的凭据上。

`resolveFreshToken()` 只在 `source === 'helper'` 且有 refreshToken 时才调刷新端点。
对 vault 的票**一次请求都不发**（测试 `resolveFreshToken never tries to refresh a vault account` 钉住这一条）。

刷新失败时：旧票还有剩余寿命就继续用（带 `refreshError`），已经死了才抛
`the stored WorkBuddy token expired and could not be refreshed`。

### 3.3 登录会话不落盘

`createLoginStore()` 是进程内 Map。`state` 是半张凭据——写进文件再忘了清，比重启即失效危险得多。
TTL 10 分钟（和上游登录页的有效期同量级）。

轮询前**先**校验 region 与 base：一个点名了别的页签的轮询既不发请求，也不会把会话删掉
（测试 `createLoginStore reports a region mismatch without burning the session` 钉住）。否则用户在两个页签之间切一下就得重登。

### 3.4 落盘在服务层，不在面板层

`poll` 成功的那一刻就 `connector.saveAccount(outcome.account)`。写盘失败返回
`signed in, but the account could not be stored: …`——而不是把 account 交给面板就算完成。
面板、`workbuddy_helper` 工具、斜杠命令三条入口因此共享同一份落盘逻辑，谁都不会漏。

---

## 4. 三条使用入口

### 面板

对话输入框左侧「会话辅助」→ **账号**页签 → 选国内版/国际版 → 「开始登录」→ 浏览器完成 → 回来点「我已完成」。
下面两段分别是「本插件保存的账号」（可刷新/移除）与「dsh-connect-workbuddy 的账号」（只读，可一键全部导入）。

### 模型工具

```json
{ "action": "account", "accountAction": "login", "region": "cn" }
{ "action": "account", "accountAction": "poll", "loginId": "wbh_…" }
{ "action": "account", "accountAction": "list" }
{ "action": "account", "accountAction": "refresh", "accountId": "…" }
{ "action": "account", "accountAction": "import" }
```

`login` 会把 `verificationUri` 与 `next` 一起返回，因为**模型不能替人扫码**——它只能把链路递出去。
`region` 一定要选人真正在用的那个：国内账号拿 `global` 的 base 会拿到一个能扫但没有账号的页面。

### 斜杠命令

```text
workbuddy-helper account login region=cn
workbuddy-helper account poll loginId=wbh_…
workbuddy-helper account list
workbuddy-helper account import
```

---

## 5. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `accountsDir` | `$DSH_HOME/workbuddy-helper/accounts` | 本插件账号库 |
| `legacyVaultDir` | `$DSH_HOME/workbuddy-vault` | 旧插件的 vault，**只读**；设为空串即完全不看它 |

`authMode` 语义没变，但 `auto` 的来源顺序变成了「自有库 → 旧 vault」；
`describeAuth()` 的 `source` 会如实显示 `helper-accounts` / `dsh-connect-workbuddy` / `snapshot-only`。

---

## 6. 验证

```powershell
node --test test/wb-login.test.mjs        # 30 条：协议、区域白名单、刷新头、会话表
node --test test/wb-vault.test.mjs        # 23 条：落盘、权限、锁、导入、脱敏
node --test test/wb-accounts.test.mjs     # 17 条：状态机、落盘时机、只对自有账号刷新
node --test test/connector-layered.test.mjs # 16 条：分层顺序、刷新写回、vault 永不写
node --test test/*.test.mjs               # 全量
```

真实账号的探测脚本没有进仓库（会带真 token）：
`POST /auth/state` 三个 base 全 200、未扫码回 11217、坏 refreshToken 回 401/12153、
`/v2/plugin/account` 回 23 字段并给出 `uid`、`/v2/plugin/login/account` 恒回 12151 空 data——
这五条就是 §2 表格的来源。
