# QQRT · 手表上的 QQ 聊天客户端（开源版）

在小米手环 / 红米手表（Vela 快应用，336×480）上收发 QQ 好友与群聊消息的完整方案：**Vela 快应用 + 自建 Next.js 服务端 + QQ 官方机器人通道**。

> QQ 没有开放个人号协议，本项目使用 **QQ 开放平台官方机器人 API**（`api.bot.qq.com`），不依赖任何第三方协议。

```
┌──────────────┐   HTTPS/JSON    ┌────────────────────┐  WebSocket   ┌──────────────┐
│ Vela 手表端   │ ──────────────▶ │  QQRT 服务端        │ ◀──────────▶ │ QQ 开放平台   │
│ 336×480 rpk  │ ◀────────────── │  Next.js + PGlite   │              │ 官方机器人    │
└──────────────┘   轮询 / 下发    └────────────────────┘              └──────────────┘
```

## 功能

**聊天**
- 好友 / 群聊消息实时同步，未读数、会话备注、消息预览
- 文本、图片、语音、视频、文件、转发的收发与查看（大图、引用、撤回、重发、删除）
- 表情以图片渲染：内置 75 个 QQ 表情码，兼容真 emoji 字符，未收录的自动隐藏
- 群聊显示发送人昵称（同一人连续发言只显示一次）
- 查看被回复的消息：点引用条滚到原消息并高亮
- 全键盘 / T9 拼音输入法、引用回复、@ 成员、@ 全体成员

**群聊管理（本版新增，全部走官方接口）**
- 群资料、机器人群内状态、群成员列表 / 成员详情
- 禁言状态查询、设置 / 解除成员禁言
- 批量移出成员、群黑名单查询 / 增删
- 入群申请列表、审批同意 / 拒绝
- 入群自动审批策略：创建、列表、启停、删除、执行、QQ 号白名单

## 官方接口文档

入口：<https://bot.q.qq.com/wiki/develop/api-v2/> → 左侧「服务端接口 → 群聊管理」

| 能力 | 官方接口 |
|---|---|
| 群资料 | `GET /v2/groups/{group_openid}/info` |
| 机器人群内状态 | `GET /v2/groups/{group_openid}/bot_state` |
| 群成员列表 / 详情 | `GET /v2/groups/{g}/members`、`GET /v2/groups/{g}/members/{member_openid}` |
| 禁言查询 / 设置 | `GET|POST /v2/groups/{g}/restrict_chat_setting` |
| 批量移出成员 | `POST /v2/groups/{g}/batch_remove_members` |
| 群黑名单 | `GET|POST /v2/groups/{g}/member_blacklist` |
| 入群申请 | `GET /v2/groups/{g}/join_request_list`、`POST /v2/groups/{g}/approval_join_request/{member_openid}` |
| 入群自动审批 | `GET|POST /v2/groups/join_approval_strategy`、`PATCH|DELETE /v2/groups/join_approval_strategy/{id}`、`POST .../{id}/execute`、`POST .../{id}/whitelist_users` |

> 文档站是 SPA，页面路径形如
> `https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_restrict_chat_setting.post.html`

权限提醒：机器人必须是群管理员；`batch_remove_members` / `member_blacklist` 属白名单能力，未开通返回错误码 **11253**，需要向 QQ 开放平台运营申请。

## 目录

```
server/   Next.js 16 + PGlite 服务端（53+ 个 /api/watch 路由）
watch/    Vela 快应用源码（aiot-toolkit 构建 rpk）
docs/     使用文档、部署说明
```

## 快速开始

### 服务端

```bash
cd server
npm install
cp .env.example .env      # 按需修改
npm run dev               # 开发
# 或 npm run build && npm start   （生产）
```

浏览器打开 `http://localhost:3005`，用管理员账号登录，在控制台填入 QQ 机器人的 **AppID / AppSecret** 并连接。
其它部署方式见 `server/deploy/部署说明.md`、`server/deploy-free/README.md`（Docker / Debian / 免费主机）。

### 手表端

```bash
cd watch
npm install
npx aiot build      # 调试包
npx aiot release    # 签名发布包 → dist/*.rpk
```

登录页填「服务器地址 + 服务端网站账号 + 密码」。

## 安全

- AppSecret 只保存在服务端并用 `data/secret.key` 加密，**绝不下发到手表**
- 仓库内不含任何真实密钥、数据库、媒体缓存；`.env` 由 `.env.example` 生成
- 手表所有请求带访问令牌，服务端按用户隔离数据

## 许可

MIT —— 见 [LICENSE](./LICENSE)。

第三方素材：`watch/src/common/emoji/` 内的表情图来自 [emoji-datasource-twitter](https://github.com/jdecked/twemoji)（CC-BY 4.0）。
