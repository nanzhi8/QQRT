#!/usr/bin/env bash
set -euo pipefail

APP_NAME="qqwatchtest"
APP_DIR="/opt/qqwatchtest"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "请使用 root 运行：sudo bash $0"
  exit 1
fi

if ! command -v curl >/dev/null; then
  apt-get update
  apt-get install -y curl
fi

if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  echo "[1/8] 安装 Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "[2/8] 安装系统依赖"
apt-get update
apt-get install -y ffmpeg nginx postgresql postgresql-contrib
npm install -g pm2

echo "[3/8] 读取部署配置"
DEFAULT_DOMAIN="example.com"
DEFAULT_BASE_PATH="/qqbotwatch"
DEFAULT_PORT="3005"
DEFAULT_DB_USER="qqrt_user"
DEFAULT_DB_NAME="qqrt_db"

read -r -p "域名（不带 https://，默认 $DEFAULT_DOMAIN）：" DOMAIN
DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
read -r -p "部署路径（默认 $DEFAULT_BASE_PATH）：" BASE_PATH
BASE_PATH="${BASE_PATH:-$DEFAULT_BASE_PATH}"
read -r -p "Next 端口（默认 $DEFAULT_PORT）：" PORT
PORT="${PORT:-$DEFAULT_PORT}"
read -r -p "数据库用户（默认 $DEFAULT_DB_USER）：" DB_USER
DB_USER="${DB_USER:-$DEFAULT_DB_USER}"
read -r -p "数据库名（默认 $DEFAULT_DB_NAME）：" DB_NAME
DB_NAME="${DB_NAME:-$DEFAULT_DB_NAME}"
read -r -s -p "数据库密码：" DB_PASSWORD
echo
if [[ -z "$DB_PASSWORD" ]]; then
  DB_PASSWORD="$(openssl rand -hex 16)"
  echo "已自动生成数据库密码"
fi

echo "[4/8] 复制服务端源码"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
tar -C "$SOURCE_DIR" \
  --exclude=.env \
  --exclude=data \
  --exclude=node_modules \
  --exclude=.next \
  --exclude=logs \
  --exclude=.git \
  -cf - . | tar -C "$APP_DIR" -xf -

echo "[5/8] 创建 .env"
cat > "$APP_DIR/.env" <<EOF
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}
DATA_DIR=./data
LOG_LEVEL=info
MAX_UPLOAD_MB=100
PORT=${PORT}
NEXT_PUBLIC_BASE_PATH=${BASE_PATH}
EOF

echo "[6/8] 初始化数据库"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;
SQL
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1 || sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"

echo "[7/8] 安装 npm 依赖并构建"
cd "$APP_DIR"
npm install --no-audit --no-fund
npm run typecheck
npm run build

echo "[8/8] 配置 PM2 并保存进程"
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs
pm2 save --force
pm2 startup systemd -u root --hp /root >/dev/null || true

echo
echo "服务端部署完成：$APP_DIR"
echo "请自行配置 nginx HTTPS 反代，可参考 deploy/nginx.conf.example"
echo "添加用户页面：https://${DOMAIN}/qqbotadduser"
echo "主站路径：https://${DOMAIN}${BASE_PATH}"
