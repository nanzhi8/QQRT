# 部署到「免费 + 有公网 IP」的主机

先说结论，避免白折腾：

| 平台 | 免费吗 | 有公网 IP | 能跑 Node + Postgres + 长连接 | 结论 |
|---|---|---|---|---|
| **Oracle Cloud Always Free**（ARM 4C/24G） | ✅ 永久免费 | ✅ 独立公网 IPv4 | ✅ 完整 Linux + Docker | **推荐** |
| Google Cloud e2-micro | ✅ 永久免费（限美区） | ✅ 需自己配 | ✅ | 可用，注册麻烦 |
| Render / Koyeb 免费档 | ✅ | ✅ 域名 | ⚠️ 闲置 15 分钟会**睡眠**，机器人长连接会断 | 只适合演示 |
| Railway | ❌ 仅试用额度 | ✅ | ✅ | 会欠费 |
| Vercel / Cloudflare Workers | ✅ | ✅ | ❌ **Serverless 跑不了 WebSocket 长连接**，也没有 Postgres | 不可用 |
| Hugging Face Spaces（Docker） | ✅ | ✅ 自带 https 域名 | ⚠️ 会睡眠、存储非持久 | 演示可以，见 `huggingface/` |

**为什么必须常驻**：QQ 机器人是 WebSocket 长连接（网关推送），进程一停机器人就掉线、收不到消息。
所以只能选「能长期运行的 VM/容器」，不能选 Serverless。

---

## 推荐方案：Oracle Cloud 永久免费 ARM 实例

免费额度（Always Free，无需付费，注册时只做 $1 预授权验证）：

- Ampere A1（ARM64）：**4 OCPU / 24GB 内存 / 200GB 磁盘**（每月 3000 OCPU 小时，1 台常开刚好）
- 1 个公网 IPv4（保留 IP，重启不变）
- 10TB/月出网流量

跑这个服务端绰绰有余（我们实测 Node 进程只占 150MB 左右）。

### 步骤

**1. 注册** <https://www.oracle.com/cloud/free/>
需要：邮箱 + 手机号 + 一张信用卡/银联卡（只验证，不扣费）。选一个离你近的区域（如「日本东京」「韩国首尔」），国内访问延迟较低。

**2. 创建实例**
- 菜单：Compute → Instances → Create Instance
- Image：**Ubuntu 22.04**（ARM 版）
- Shape：**VM.Standard.A1.Flex**，4 OCPU / 24GB
- 勾选 **Assign a public IPv4 address**
- 上传 SSH 公钥（或用平台生成的密钥对，务必下载保存）

**3. 放行端口**（很关键，不做的话外网打不开）
- 实例详情 → Primary VNIC → Subnet → Security List → Add Ingress Rules：
  - `0.0.0.0/0` TCP **80**（Caddy 申请证书 + HTTP 跳转）
  - `0.0.0.0/0` TCP **443**（HTTPS）
- 实例内部还有防火墙，`setup.sh` 会自动处理。

**4. 上传代码并执行**
```bash
# 本机打包（排除 node_modules 等）
scp -r qqrt-server ubuntu@<公网IP>:~/

ssh ubuntu@<公网IP>
cd ~/qqrt-server
sudo bash deploy-free/oracle/setup.sh
```

脚本会：装 Docker → 生成 `.env` → 用你的公网 IP 自动拼出 `xxx.xxx.xxx.xxx.sslip.io` 域名 →
起 `app + postgres + caddy` → Caddy 自动申请 Let's Encrypt 证书。

**5. 初始化**
```bash
cd ~/qqrt-server
sudo docker compose -f deploy-free/oracle/docker-compose.yml exec app npx drizzle-kit push --force

curl -X POST https://<你的域名>/api/admin/setup \
  -H "Content-Type: application/json" -d '{"password":"你的网站密码"}'
```

**6. 用起来**
- 浏览器开 `https://<你的域名>`，用 `admin` + 刚才的密码登录，填机器人 AppID/AppSecret
- 手环：服务器地址填 `https://<你的域名>`（不带端口、不带结尾斜杠），账号 `admin`

> 没有域名也没关系：`sslip.io` 是免费的通配 DNS，`1.2.3.4.sslip.io` 会解析到 `1.2.3.4`，
> Let's Encrypt 可以给它签发证书。所以 HTTPS 不需要买域名。
> 有自己的域名更好：`sudo bash deploy-free/oracle/setup.sh qq.example.com`，再把域名 A 记录指到 IP。

---

## 备选 A：Cloudflare Tunnel（不用公网 IP、不用买服务器）

如果不想注册云账号，用**现在这台电脑**就能拿到 https 公网地址：

```powershell
# 1. 装 cloudflared（Windows）
winget install --id Cloudflare.cloudflared

# 2. 起隧道（临时域名，重启就变）
cloudflared tunnel --url http://127.0.0.1:3005
```

它会打印一个 `https://xxxx.trycloudflare.com`，手环直接填这个地址。
缺点：电脑关机就断；免费临时域名每次重启会变。要固定域名得绑 Cloudflare 账号（也免费）。

---

## 备选 B：Hugging Face Spaces（Docker，免费）

见 `huggingface/` 目录。适合「只想给别人演示一下」，不适合长期用：
会睡眠、磁盘非持久（重建后数据没了）、而且**没有登录保护**，任何人都能打开控制台。

---

## 常见问题

**1. 手环连不上 / 提示网络失败**
- 必须 **https**，且证书有效（`sslip.io` 域名 Caddy 会自动签）
- 手环里地址别带端口、别带结尾 `/`
- 先在手机浏览器打开 `https://<域名>/api/health`，应返回 `{"ok":true}`

**2. 502 / 页面打不开**
`sudo docker compose -f deploy-free/oracle/docker-compose.yml logs -f caddy app` 看日志；
多半是 OCI 安全列表没放行 80/443。

**3. 机器人一直离线**
看 `app` 日志有没有 `bot connected`。没有就是 AppID/AppSecret 不对，或机器人没在开放平台上线。

**4. 内存/磁盘**
ARM 4C24G 用不完；磁盘主要被 Docker 镜像占（约 1.5GB）。定期 `docker system prune -f`。

**5. 想换域名**
改 `deploy-free/oracle/Caddyfile` 里的域名 → `docker compose restart caddy`。
