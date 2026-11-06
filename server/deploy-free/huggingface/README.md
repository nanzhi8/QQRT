---
title: QQRT Server
emoji: 💬
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# QQRT 服务端（Hugging Face Spaces 版）

> ⚠️ **仅适合临时演示**：免费 Space 会睡眠、磁盘非持久、而且**没有登录保护**——
> 任何拿到链接的人都能打开控制台。长期使用请按 `../README.md` 用 Oracle 免费实例。

## 怎么用

1. 注册 <https://huggingface.co>，右上角 **New → Space**
2. SDK 选 **Docker**，模板选 **Blank**，硬件 **CPU basic（免费）**
3. 把 `qqrt-server` 整个目录的内容推到 Space 仓库（**不要**包含 `node_modules`、`.next`、`pgdata`、`data`、`logs`）
4. 把本目录的 `Dockerfile` 复制成仓库根目录的 `Dockerfile`，本 `README.md` 覆盖根目录的 `README.md`
5. 等构建完成，地址是 `https://<用户名>-<space名>.hf.space`

推送示例：

```bash
cd qqrt-server
rm -rf node_modules .next pgdata data logs
cp deploy-free/huggingface/Dockerfile ./Dockerfile
cp deploy-free/huggingface/README.md ./README.md

git init && git lfs install
git remote add space https://huggingface.co/spaces/<用户名>/<space名>
git add -A && git commit -m "deploy qqrt"
git push space main
```

## 部署后

```bash
# 创建管理员（容器起来后执行一次）
curl -X POST https://<用户名>-<space名>.hf.space/api/admin/setup \
  -H "Content-Type: application/json" -d '{"password":"你的网站密码"}'
```

> 建表不用管：镜像里已设 `AUTO_MIGRATE=1`，容器启动时会自动 `drizzle-kit push --force`。
> 首次启动到能打开首页大约 1–2 分钟（含 PGlite 初始化）。

## 已知限制

| 限制 | 影响 |
|---|---|
| 免费 Space 15 分钟无访问会睡眠 | 机器人长连接断开，收到消息会延迟到下次唤醒 |
| 磁盘非持久 | 重建后数据库清空，需要重新建管理员、重新绑机器人 |
| 无登录保护 | 任何人打开链接都能看到控制台 |
| 单核 CPU / 512MB 内存 | 够单人用，图片转码会慢 |

长期使用请换 `../README.md` 里的 Oracle 免费实例（4C/24G，永久免费，不睡眠）。

## 手环填写

服务器地址：`https://<用户名>-<space名>.hf.space`

账号 `admin`，密码是上面 `/api/admin/setup` 设的那个。
