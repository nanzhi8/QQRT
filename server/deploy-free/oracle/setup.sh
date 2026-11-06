#!/usr/bin/env bash
# QQRT 服务端 · 一键部署到 Ubuntu 22.04+（Oracle Cloud 免费 ARM 实例 / 任意 VPS）
#
# 用法：
#   cd qqrt-server
#   sudo bash deploy-free/oracle/setup.sh              # 自动用 <公网IP>.sslip.io 做域名
#   sudo bash deploy-free/oracle/setup.sh qq.example.com
#
# 做的事：装 Docker → 生成 .env（域名 + 随机数据库密码）→ 起 app + postgres + caddy
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"

say() { printf '\n\033[1;36m[qqrt]\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m[qqrt] %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash $0"
[[ -f "$PROJECT_DIR/package.json" ]] || die "没找到 $PROJECT_DIR/package.json，请在 qqrt-server 目录内运行"

# ---------- 1. 依赖 ----------
say "检查 Docker"
if ! command -v docker >/dev/null 2>&1; then
  say "安装 Docker（官方脚本，约 1 分钟）"
  curl -fsSL https://get.docker.com | sh
else
  say "Docker 已安装：$(docker --version)"
fi

if ! docker compose version >/dev/null 2>&1; then
  say "安装 docker compose 插件"
  apt-get update -qq && apt-get install -y docker-compose-plugin
fi

# ---------- 2. 域名 ----------
PUBLIC_IP="$(curl -fsS --max-time 8 https://api.ipify.org || curl -fsS --max-time 8 https://ifconfig.me || true)"
DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  [[ -n "$PUBLIC_IP" ]] || die "拿不到公网 IP，请手动指定域名：sudo bash $0 your.domain.com"
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  say "未指定域名，使用免费域名：$DOMAIN（解析到 $PUBLIC_IP）"
else
  say "使用域名：$DOMAIN"
fi

# ---------- 3. 环境文件 ----------
DB_PASSWORD="$(openssl rand -hex 12 2>/dev/null || head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)"
if [[ -f "$ENV_FILE" ]]; then
  say "沿用已有 $ENV_FILE（改域名请直接编辑后重启 caddy）"
  # 只更新 DOMAIN，其余保持
  if grep -q '^DOMAIN=' "$ENV_FILE"; then
    sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" "$ENV_FILE"
  else
    printf 'DOMAIN=%s\n' "$DOMAIN" >> "$ENV_FILE"
  fi
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  DB_PASSWORD="${DB_PASSWORD:-change-me-please}"
else
  cat > "$ENV_FILE" <<EOF
# 由 setup.sh 生成于 $(date '+%F %T')
DOMAIN=$DOMAIN
DB_PASSWORD=$DB_PASSWORD
EOF
  chmod 600 "$ENV_FILE"
  say "已生成 $ENV_FILE（数据库密码随机，别删）"
fi

# ---------- 4. 主机防火墙 ----------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  say "放行 ufw 80/443"
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
fi
# Oracle 的 Ubuntu 镜像自带 iptables REJECT 规则，会挡掉 80/443
if command -v iptables >/dev/null 2>&1; then
  say "检查 iptables 是否拦截 80/443"
  for port in 80 443; do
    if iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
      :
    else
      iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT 2>/dev/null || true
      say "已为 $port 添加放行规则（重启后失效，建议 apt install iptables-persistent 固化）"
    fi
  done
fi

# ---------- 5. 起服务 ----------
say "构建并启动（首次约 3–6 分钟）"
cd "$PROJECT_DIR"
set -a; source "$ENV_FILE"; set +a
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build

say "等待服务就绪…"
for i in $(seq 1 60); do
  if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T app \
      node -e "fetch('http://127.0.0.1:3005/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    say "服务已就绪"
    break
  fi
  sleep 3
  [[ $i -eq 60 ]] && die "60 次探测仍未就绪，看日志：docker compose -f $COMPOSE_FILE logs app"
done

# ---------- 6. 建表 ----------
say "同步数据库表结构"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T app npx drizzle-kit push --force

cat <<EOF

============================================================
 部署完成
============================================================
 访问地址：https://$DOMAIN
 健康检查：https://$DOMAIN/api/health      （应返回 {"ok":true}）

 下一步：
 1) 创建管理员（密码换成你自己的）：
    curl -X POST https://$DOMAIN/api/admin/setup \\
      -H "Content-Type: application/json" -d '{"password":"你的网站密码"}'

 2) 浏览器打开 https://$DOMAIN ，用 admin + 上面的密码登录，
    填 QQ 机器人 AppID / AppSecret

 3) 手环「服务器地址」填：https://$DOMAIN
    账号 admin，密码同上

 常用命令：
   docker compose -f $COMPOSE_FILE logs -f app
   docker compose -f $COMPOSE_FILE restart app
   docker compose -f $COMPOSE_FILE down
 数据库密码保存在：$ENV_FILE
============================================================
EOF
