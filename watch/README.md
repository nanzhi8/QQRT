# QQRT for Xiaomi Vela（手环 9 Pro / 10 Pro / Watch S5）

把小天才快应用版的 QQRT（QQ 机器人手表客户端）重写为**小米 Vela JS 应用**，
适配小米手环 9 Pro / 10 Pro（336×480 矩形）、红米手表 6，以及 Xiaomi Watch S5（480×480 圆屏 / eSIM）。

- 网络：只走 `@system.fetch`
- 输入法：**喵喵输入法**（页面化版本，自带 `dic.js` 词库）
- UI：**无源流沙**风格（黑底 + `#262626` 圆角卡片 + `#3184d0` 强调色）
- 包名 `com.qqrt.band` / 版本 4.0.0（versionCode 60）
- 产物：`dist/com.qqrt.band.release.4.0.0.rpk`（约 114 KB，已用 `sign/` 自签证书签名）

---

## 1. 为什么不能"改包重签"，只能重写

原 `QQRT-3.0-vc55.rpk` 是**快应用经典工具链**的编译产物：

```js
$app_define$("@app-component/index", [], function (i, o, a) { ... a.exports.template = template })
$app_bootstrap$("@app-component/index", { packagerVersion: "1.9.16" })
```

模板是普通 JSON AST，样式是 `{".page": {...}}` 对象，`minPlatformVersion: 1070`，依赖
`system.input.openInputMethod`、`system.media`、`system.request.download`。

小米 Vela（手环 9 Pro）的运行时要求**完全不同的模块 ABI**（官方 `aiot-toolkit@2.0.5` 实测产物）：

```js
export default function (global, globalThis, window, $app_exports$, $app_evaluate$) { ... }
$app_exports$['entry'] = function ($app_exports$) { ... }
// 模板：aiot.__ce__("div", { __vm__, __opts__: { classList, ... } }, [ ... ])
// 样式：[[[ [0,"page"] ], { width:"336px", ... }], ...]
```

入口签名、模板表示、样式表示全部不同，**老包 JS 在 Vela 上无法执行**，因此按 Vela 规范重写源码，
只保留服务端 `/api/watch/*` 协议。

| 项目 | 小天才老包 | Vela（手环 9 Pro） |
| --- | --- | --- |
| 编译产物 | `$app_define$` / `$app_bootstrap$` | `$app_exports$.entry` + `aiot.__ce__` |
| 模板 | JSON AST | 编译成渲染函数 |
| 文本输入 | `system.input.openInputMethod` | 无该接口，`input` 组件只支持 button/checkbox/radio |
| 图片选择 | `system.media` | 无（已移除） |
| 语音 | 录音 + 播放 | 无录音（已移除） |
| 下载/上传 | `system.request.download/upload` | 官方支持表标注手环 9/9 Pro 不支持 |
| 网络 | `fetch` + download 兜底 | 只用 `fetch` |
| 设计基准 | `designWidth: 240`（240×240） | `designWidth: 336`（336×480） |

---

## 2. 功能

- 登录：服务器地址（支持 dpaste 短码解析）、网站账号、密码；token 存本机
- 会话列表：未读红点、最后一条预览、时间、机器人状态、手动同步、3.5s 轮询、顶部时钟
- 聊天：气泡收发、群昵称、引用回复、时间分隔、长按菜单（引用回复 / @ 发送者 / 撤回 / 重发 / 删除）
- 聊天滚动：`list` 可上下滑动，进页 / 发消息自动定位到最新；手动上滑后暂停跟随，滑回底部恢复
- 气泡自适应：按**真实字宽**模拟折行（中文 21px / 字母 10.4px / 数字 8.2px），单行消息气泡自动收窄，多行按行数给高度，
  文字节点带显式宽高（Vela 的 text 不撑父容器，必须写死），长消息完整显示、短消息不再拉成一条长条
- 消息菜单：**点一下气泡**即弹出菜单（引用回复 / @ 发送者 / 撤回 / 重发 / 查看大图 / 删除），长按同样可用
- 会话名称：标题优先显示服务端备注名（`conversations.remark`），无备注时显示真实群名 / `QQ好友·后四位`；
  聊天页进入时拉 `/api/watch/convo` 取权威名称，仍是占位名时自动调 `/api/watch/refresh-names` 再解析一次；
  首页启动也会刷一遍，设置页有「刷新会话名称」入口；**长按标题**（聊天页）或**长按会话**（首页）可改名
- 发送：文字 + 24 个 QQ 表情快捷码 + @群成员
- 群成员页：选人回填 @
- 好友 / 群请求：同意 / 拒绝
- 设置：服务器地址、账号、机器人状态、重置同步进度、退出登录
- 输入法：喵喵输入法页（拼音全键盘 / 九键 / 英文 / 数字符号，方屏 `rect` 布局，自带词库）

已移除：图片 / 视频 / 语音的收发与查看（显示 `[图片]` `[语音]` 文字标签）、贴纸图片、媒体大图页、
rpk 安装页、富文本页、消息转发。

---

## 3. 目录

```
qqvela/
├── package.json
├── sign/                        # 打包证书（自签，可替换）
│   ├── private.pem
│   └── certificate.pem
├── src/
│   ├── manifest.json            # designWidth 336 / features / router
│   ├── app.ux                   # 全局变量（屏幕形态 + 输入法传参）
│   ├── common/api.js            # fetch 网络层 + storage + 工具函数
│   ├── Ime/
│   │   ├── ime.ux               # 喵喵输入法（页面化，252 KB 含资源）
│   │   └── assets/              # 按键图 + dic.js 词库 + dicUtil.js
│   ├── Login/index.ux
│   ├── Home/index.ux
│   ├── Chat/index.ux
│   ├── Members/index.ux
│   ├── Requests/index.ux
│   └── Settings/index.ux
└── dist/com.qqrt.band.release.4.0.0.rpk
```

### 输入法对接方式（与 daymatter 一致）

输入法是**独立页面**，通过 `global` 传参、`router.back()` 回传，不用组件事件：

```js
// 调用页
global.__imeText = '已有文本'
global.__imeLabel = '服务器地址'
global.__imeResult = null
router.push({ uri: 'Ime' })

// 调用页 onShow
const r = global.__imeResult
if (r && r.confirmed) this.host = r.text
global.__imeResult = null
```

`app.ux` 里必须提供屏幕形态，否则输入法会退化成胶囊屏布局：

```js
global.screenShape = 'rect'                       // rect / circle / pill-shaped
global.screenSize = { width: 336, height: 480 }
```

### 网络层（`common/api.js`）

```js
fetch.fetch({
  url, method: 'GET' | 'POST',
  responseType: 'text',
  data: JSON.stringify(body),                    // POST
  header: { 'Content-Type': 'application/json' },
  success(resp) { /* resp.code / resp.data */ },
  fail(data, code) { /* 网络失败 */ }
})
```

token 通过查询参数 `t=` 附加；401 或 `error.type === 'AUTH_ERROR'` 统一跳登录页。

### 服务端接口（沿用旧协议）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/watch/login` | `{username,password}` → `{token}` |
| GET | `/api/watch/status` | 机器人连接状态 |
| GET | `/api/watch/sync-messages` | `?after=` → 会话列表 + 各会话新消息 |
| POST | `/api/watch/sync-all` | 全量同步 |
| GET | `/api/watch/messages` | `?conversationId&after&limit&read` |
| POST | `/api/watch/send` | `{conversationId,text,replyTo,mentions,tt,how}` |
| POST | `/api/watch/recall` | `{messageId}` |
| POST | `/api/watch/resend` | `{messageId}` |
| POST | `/api/watch/msg-delete` | `{messageId}` |
| GET | `/api/watch/members` | `?conversationId` |
| GET | `/api/watch/requests` | 好友/入群申请 |
| POST | `/api/watch/requests/decide` | `{id,op}` |
| GET | `/api/watch/test` | 连通性测试 |

---

## 4. 构建

```bash
cd qqvela
npm install                 # 安装 aiot-toolkit
npx aiot build              # 调试包 dist/*.debug.rpk
npx aiot release            # 正式包 dist/*.release.rpk（用 sign/ 证书签名）
```

> `release` 必须存在 `sign/private.pem` 与 `sign/certificate.pem`，否则报
> `The current mode is production, and there is a problem with the certification path`。
> 生成方式：`openssl req -newkey rsa:2048 -nodes -keyout private.pem -x509 -days 3650 -out certificate.pem`。
> 要上架或与手机端互通，需换成官方证书。

### 在 AIoT-IDE 里模拟

1. 打开 AIoT-IDE →「文件」→「打开文件夹」，选择 **`qqvela`**（含 `package.json` 与 `src/` 的那一层，不要选 `src`）。
2. 右侧开发向导点「安装依赖」（首次会 `npm i`）；国内网络慢就在项目根新建 `.npmrc`：
   `registry=https://registry.npmmirror.com/` 后重跑 `npm i`。
3. 开发向导里「检查模拟器环境，创建模拟器实例」→ 自动安装 → 新建模拟器，屏幕选 **方屏 336×480**。
4. 顶部 banner 选设备 →「调试」，模拟器里跑起来后底部可看 DOM 树 / Console。
5. 模拟器里 `fetch` 走电脑网络，登录时填真实服务器地址即可联调；输入法页点输入行确认，返回上一页。

---

## 5. 安装到手表

方式一（官方 Debug 通道）：

1. 手机安装**小米运动健康**，与手环 9 Pro 配对同步；
2. `我的 → 关于 → Debug → 第三方应用 → Click to input package name`（随便填）；
3. `Install third app` 选 `dist/com.qqrt.band.release.4.0.0.rpk`；
4. 手环应用列表出现 QQRT，填服务器 + 账号密码登录。

方式二（社区工具）：米坛「表盘自定义工具」的第三方应用安装入口选择 rpk。

> 官方接口支持表把 `fetch / request / network` 在「小米手环 9 / 9 Pro」标为**不支持**（文档可能滞后于固件）。
> 若固件确实不提供网络接口，纯手环端无法联网，需要手机端代理。

---


## 5.2 合并社区 PR #1（4.12.1）

`qihe114514/feature/keyboard-auto-login` 已合并。新增：

- `src/components/InputMethod/`：新输入法组件，支持拼音**词组候选**、键盘懒创建（进页不再一次性建 200+ 节点）、敏感输入星号显示；`src/Ime/ime.ux` 变为薄封装。
- 登录页可选「保存账号密码并自动登录」，凭据存在本机 `storage`；**切换服务器 / 退出登录 / 关闭开关时自动清除**。
- `manifest.json` 增加 `system.file` 声明（词库读取需要）。

> 该组件圆屏键盘同样按 `designWidth 480` 写死，合并时已对圆屏分支 229 处内联尺寸 ×0.7
> 并补 `@media (shape: circle)` 共用按键样式，S5 上不会再次溢出。
> PR 里「同步上游群管理」的提交基于旧版，合并时保留本仓库更新的群管理代码。

## 5.1 多设备适配：Xiaomi Watch S5 / eSIM（4.11.11+）

Vela 官方 `fetch` 支持明细（2026-11 查证）：

| 设备 | 原生 fetch | QQRT 联网方式 |
|---|---|---|
| **Xiaomi Watch S5**（含 eSIM 版） | 支持 | Wi-Fi / eSIM 蜂窝**直连**，不需要 TUN 模块 |
| Watch S3 / S4、REDMI Watch 5 / 6、S1 Pro | 支持 | Wi-Fi 直连 |
| 小米手环 9 / 9 Pro / 10 / 10 Pro | 不支持 | 手机代理 + TUN 模块 + CA 补丁 |

**一套 rpk 通吃**：`designWidth` 保持 336，Vela 按物理宽度等比缩放；`app.ux` 用
`device.getInfo()` 算出 `designH = 336 * sh / sw`，各页面用 `vh` 动态布局。

- S5 是 **480×480 圆屏，`designH` 只有 336**（对比手环的 480）。4.11.11 曾把圆屏下
  固定宽度收缩到 `288px`，结果内部按 336 计算的气泡/行宽全部错位，**4.11.13 已撤销该收缩**，
  一律保持 `width: 336px` 满宽，比例与手环完全一致。
- **高度/滚动**：登录页、设置页原本是按 480 高写死的静态堆叠，在 336 高的圆屏上底部被截且滚不动。
  现已用 `<scroll scroll-y="true" style="height:{{vh}}px">` 包住内容；看大图页图片高度改为 `vh`；
  聊天页引用条改成 `position:absolute`（不再占文档流挤出输入栏）；首页 / 设备页列表高度常数修正。
- **设置 → 设备与网络**：显示型号、系统、平台版本、屏幕形状、原生联网判断；
  点右上「重测」实测 `/api/health`，并给出「可直连 / 证书失败 / 无网络 / 服务端异常」的建议。
- 网络错误码已翻译成人话（60=缺根证书、6=DNS、7=连不上、28=超时），不再只显示「网络连接失败(60)」。
- **蜂窝 / eSIM**（4.11.13）：`fetch` 的 6/7/28 属于蜂窝首次建链常见错误，`probeNetwork()` 会自动
  重试 3 次（间隔 1.5s）并加 15s 看门狗；普通 GET 请求自动重试 1 次，**POST 永不重试**（避免重复发消息）。
  诊断页会显示重试次数，并在「Wi-Fi 能连、蜂窝不能」时明确提示多为系统未给第三方应用开放 eSIM 数据。
  > Vela 官方权限表里没有网络/蜂窝权限项，`system.fetch` 声明即足够；若 Wi-Fi 正常而蜂窝始终 6/7/28，
  > 属于手表系统侧限制，应用代码无法绕过，只能用 Wi-Fi 或手机代理。
- **输入法圆屏键盘**（4.11.12）：`Ime/ime.ux` 的圆屏分支来自 `designWidth 480` 的工程，写死了
  `480px / 466px / 321px`。QQRT 用 336，直接跑会被放大 1.43 倍、键盘右侧被裁。已把该分支的
  201 处内联尺寸统一 ×0.7，并在 `@media (shape: circle)` 里覆盖共用按键类（`.calbtnfull` /
  `.calbtnt9` / `.list3` 等）。`rect`（手环）与 `pill-shaped` 分支完全未改。

> Vela 没有暴露 eSIM 开关、拨号、短信之类的 API，「eSIM 能力」在这里指的是
> **利用手表自己的蜂窝 / Wi-Fi 网络直连服务端**，而不是新增通话功能。
> 是否真的直连，以「设备与网络」页的实测结果为准。

---

## 6. 主题（无源流沙）

| 用途 | 色值 |
| --- | --- |
| 页面底色 | `#000000` |
| 卡片 / 输入条 | `#262626` |
| 卡片描边 | `3px rgba(255,255,255,0.06)` |
| 次级容器（头像底） | `#363636` |
| 主文字 | `#ffffff` |
| 次文字 | `#aaaaaa` |
| 弱提示 | `#888888` |
| 强调色（按钮/未读/@） | `#3184d0` |
| 圆角 | 卡片 16–20，输入条/按钮胶囊 100 |

字号基准 336 宽：正文 21px、标题 23–34px、辅助 16–19px；列表顶部 20px 时钟（`rgba(255,255,255,0.6)`）。

---

## 7. 已知限制

- 手环无系统输入法，中文靠喵喵输入法（拼音全键盘 / 九键）。
- 群聊 @ 需先进「群成员」选人；服务端未返回 `senderOpenid` 时，长按菜单不显示「@ 发送者」。
- 未实现转发、图片/语音、贴纸图片。
- 轮询间隔 3.2–3.5s，`onHide` 停止。
- 聊天列表用固定行高（82px）承载气泡：Vela 的 `text` 不撑开父容器，行高必须写死，否则气泡塌成一条、文字被下一行盖住。
- QQ 机器人接口**不提供好友昵称**：实测 `/v2/users/{openid}` 返回 `404 不支持的调用`，`/v2/groups/{id}/info` 可用（返回 400「群不存在」说明接口存在）。
  所以私聊只能显示备注名或 `QQ好友·后四位`；群名可自动解析（`/v2/groups/{group_openid}/info`，缓存 24h）。
- `/v2/groups`（群列表）需要 QQ 开放平台单独开通权限，未开通时服务端只记一条 info 日志，不影响收发。

---

## 8. 参考文档与实例

- Vela 应用总览：<https://iot.mi.com/vela/quickapp/zh/guide/>
- 项目配置 manifest：<https://iot.mi.com/vela/quickapp/zh/guide/framework/manifest.html>
- 多屏适配规范（336×480）：<https://iot.mi.com/vela/quickapp/zh/guide/multi-screens/specs.html>
- 组件库：<https://iot.mi.com/vela/quickapp/zh/components/>
- fetch：<https://iot.mi.com/vela/quickapp/zh/features/network/fetch.html>
- storage：<https://iot.mi.com/vela/quickapp/zh/features/data/storage.html>
- router / 生命周期：<https://iot.mi.com/vela/quickapp/zh/features/basic/router.html>
- 官方示例（含输入法示例）：<https://iot.mi.com/vela/quickapp/zh/samples/>
- 喵喵输入法 + 无源流沙 UI 参考工程：<https://github.com/sf-yuzifu/daymatter>（GPL-3.0）
- 输入法原始组件：<https://github.com/NEORUAA/Vela_input_method>（MIT）
- Vela 实战工程：<https://github.com/cciccicu/JSLab>

---

## 9. 致谢 / 许可

- 输入法：**喵喵输入法**（`sf-yuzifu/daymatter` 页面化版本，源自 NEORUAA/Vela_input_method，MIT）
- UI 风格：**无源流沙**（米坛社区界面设计）
- 服务端协议：沿用原 QQRT 服务端 `/api/watch/*`
- 参考工程 `daymatter` 采用 GPL-3.0，本工程仅借用其输入法页与视觉规范，如需再分发请遵循相应许可。
