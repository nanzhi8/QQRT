#!/usr/bin/env bash
#
# QQ助手（手表 + 服务端）Debian 12 / Debian 13 一键部署脚本
#
# 用法（在解压后的项目根目录执行，必须是 root）：
#   DB_PASS='你的强数据库密码' bash deploy/install-debian.sh
#
# 可选环境变量：
#   APP_DIR     应用目录（默认 /opt/qqbot-watch）
#   APP_USER    运行应用的系统用户（默认 qqbot）
#   DB_NAME     数据库名（默认 qqbot_web）
#   DB_USER     数据库用户（默认 qqbot）
#   PORT        应用监听端口（默认 3004）
#   SERVER_NAME nginx server_name（默认 _，即接受任意 Host）
#
# 脚本做的事：装依赖 → 建用户 → 复制代码 → 装依赖 → 建库建表 → 构建 → PM2 常驻 → nginx 反代。
# 可重复执行（幂等）。
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/qqbot-watch}"
APP_USER="${APP_USER:-qqbot}"
DB_NAME="${DB_NAME:-qqbot_web}"
DB_USER="${DB_USER:-qqbot}"
DB_PASS="${DB_PASS:-}"
PORT="${PORT:-3004}"
SERVER_NAME="${SERVER_NAME:-_}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m[!] %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "请用 root 运行（sudo -i 后再执行）"
  exit 1
fi
if [[ -z "$DB_PASS" ]]; then
  echo "请先设置数据库密码，例如："
  echo "  DB_PASS=\"\$(head -c 18 /dev/urandom | base64 | tr -d '/+=')\" bash deploy/install-debian.sh"
  exit 2
fi

# ── 0. 低内存保护：构建 Next.js 需要较多内存，2G 机器建议先加 swap ──────────
log "检查内存与 swap"
TOTAL_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/{printf "%d", $2/1024}' /proc/meminfo)
echo "内存: ${TOTAL_MB}MB  swap: ${SWAP_MB}MB"
if [[ "$SWAP_MB" -lt 512 && "$TOTAL_MB" -lt 3072 ]]; then
  if [[ ! -f /swapfile ]]; then
    warn "内存偏小且无 swap，创建 2G swapfile（否则 next build 可能被 OOM Killer 杀掉）"
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "swapfile 已启用并写入 /etc/fstab"
  else
    echo "/swapfile 已存在，跳过"
  fi
fi

# ── 1. 系统依赖 ────────────────────────────────────────────────────────────
log "安装系统依赖（ffmpeg / postgresql / nginx / unzip 等）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg ffmpeg postgresql nginx unzip

# ── 2. Node.js >= 20 ──────────────────────────────────────────────────────
log "检查 Node.js"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "${NODE_MAJOR:-0}" -lt 20 ]]; then
  echo "当前 Node 主版本 ${NODE_MAJOR}，安装 NodeSource 22.x"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
else
  echo "Node $(node -v) 可用"
fi
node -v
npm -v

# ── 3. 运行用户 ────────────────────────────────────────────────────────────
log "准备运行用户 $APP_USER"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --create-home --shell /usr/sbin/nologin "$APP_USER"
  echo "已创建系统用户 $APP_USER"
else
  echo "用户 $APP_USER 已存在"
fi
mkdir -p "$APP_DIR"

# ── 4. 复制代码 ────────────────────────────────────────────────────────────
log "复制项目到 $APP_DIR"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$SRC_DIR" == "$APP_DIR" ]]; then
  echo "已在应用目录内，跳过复制"
else
  # 排除本机运行产物，避免把开发机的 node_modules / .next 带过去
  tar -C "$SRC_DIR" \
      --exclude=./node_modules --exclude=./.next --exclude=./data \
      --exclude=./logs --exclude=./.git --exclude='*.tsbuildinfo' \
      -cf - . | tar -C "$APP_DIR" -xf -
  echo "代码已复制"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── 5. 安装依赖（必须含 devDependencies：next build 需要 typescript）──────
log "安装 npm 依赖"
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && npm install --no-audit --no-fund"

# ── 6. PostgreSQL：建角色 + 建库 ──────────────────────────────────────────
log "配置 PostgreSQL"
systemctl enable --now postgresql

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
  echo "已创建数据库 $DB_NAME"
else
  echo "数据库 $DB_NAME 已存在"
fi

# ── 7. 生成 .env 与加密密钥 ────────────────────────────────────────────────
log "写入 .env 与 secret.key"
mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
SECRET_KEY_PATH="$APP_DIR/data/secret.key"
if [[ ! -f "$SECRET_KEY_PATH" ]]; then
  # 必须是恰好 32 字节的原始密钥（secret.ts 校验 length === 32）。
  # base64 后的 32 字节是 44 字符，会被判定损坏并重新生成，导致已保存的
  # AppSecret 无法解密。
  umask 077
  head -c 32 /dev/urandom > "$SECRET_KEY_PATH"
fi

cat > "$APP_DIR/.env" <<EOF
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}
DATA_DIR=${APP_DIR}/data
LOG_LEVEL=info
MAX_UPLOAD_MB=200
PORT=${PORT}
NEXT_PUBLIC_BASE_PATH=
EOF

chown -R "$APP_USER:$APP_USER" "$APP_DIR/data" "$APP_DIR/logs"
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env" "$SECRET_KEY_PATH"

# ── 8. 建表（drizzle push，非交互）────────────────────────────────────────
log "同步数据库表结构"
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && set -a && . ./.env && set +a && npx drizzle-kit push --force"

# ── 9. 构建 ────────────────────────────────────────────────────────────────
log "生产构建（NODE_OPTIONS 放宽堆上限，避免 2G 机器 OOM）"
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && NODE_OPTIONS=--max-old-space-size=1024 npm run build"

# ── 10. PM2 常驻（以 $APP_USER 运行，不用 root）────────────────────────────
log "配置 PM2 常驻"
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2 --no-audit --no-fund
fi

sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && pm2 start ecosystem.config.cjs && pm2 save"
pm2 startup systemd -u "$APP_USER" --hp "$APP_DIR" | tail -1 | bash || warn "pm2 startup 自动执行失败，请手动执行上面输出的命令"

sleep 3
sudo -u "$APP_USER" -H pm2 status || true

# ── 11. nginx 反代 ─────────────────────────────────────────────────────────
log "配置 nginx 反向代理（127.0.0.1:${PORT}）"
cat > /etc/nginx/sites-available/qqbot-watch <<EOF
server {
    listen 80;
    server_name ${SERVER_NAME};

    # 上传大文件（语音/图片/文件）
    client_max_body_size 200m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
        # 手表长轮询最多等待 20s，必须大于该值
        proxy_read_timeout 65s;
        proxy_send_timeout 65s;
        proxy_buffering off;
    }
}
EOF
ln -sf /etc/nginx/sites-available/qqbot-watch /etc/nginx/sites-enabled/qqbot-watch
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ── 12. 自检 ───────────────────────────────────────────────────────────────
log "健康检查"
sleep 2
if curl -fsS -m 10 "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
  echo "服务端健康检查通过"
else
  warn "健康检查失败，请查看日志：sudo -u ${APP_USER} pm2 logs qqbot-web"
fi

cat <<EOF

============================================================
部署完成
============================================================
应用目录 : ${APP_DIR}
运行用户 : ${APP_USER}
监听端口 : 127.0.0.1:${PORT}
数据库   : ${DB_NAME}（用户 ${DB_USER}）
健康检查 : curl http://127.0.0.1:${PORT}/api/health

下一步：
  1. （强烈建议）给站点配置 HTTPS 证书：
       apt install -y certbot python3-certbot-nginx
       certbot --nginx -d 你的域名
     手表端用 http 明文传输 token 不安全，务必上 HTTPS。
  2. 浏览器打开站点 → 注册「网站内部账号」→ 登录。
  3. 在网页里填入 QQ 机器人 AppID + AppSecret → 保存并连接。
  4. 保持「常驻接收」开启（关闭浏览器后服务器仍持续收消息）。
  5. 手表端：设置服务器地址 → 测试连接 → 用同一个网站账号登录。

常用命令：
  sudo -u ${APP_USER} pm2 logs qqbot-web      # 看日志
  sudo -u ${APP_USER} pm2 restart qqbot-web   # 重启
  systemctl status nginx postgresql
============================================================
EOF
