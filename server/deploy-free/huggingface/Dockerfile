# Hugging Face Spaces 用的 Dockerfile
# 用法：把本文件复制成项目根目录的 `Dockerfile`，整个 qqrt-server 内容推到 Space 仓库即可。
# 特点：单容器，内置 PGlite（Postgres 18 WASM）作为数据库，监听 7860。

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* .npmrc* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .
RUN npm run build

# 数据库用内嵌 PGlite，数据目录放在 /app/pgdata（HF 免费盘非持久，重建即清空）
ENV NODE_ENV=production \
    PORT=7860 \
    PGLITE_PORT=5432 \
    DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres \
    PG_POOL_MAX=4 \
    NEXT_TELEMETRY_DISABLED=1 \
    AUTO_MIGRATE=1 \
    TZ=Asia/Shanghai

# HF Spaces 以 uid 1000 运行，目录要可写
RUN mkdir -p /app/pgdata /app/data && chown -R 1000:1000 /app
USER 1000

EXPOSE 7860

# run-all.mjs：先起 PGlite（Postgres 线协议），再起 Next.js
CMD ["node", "run-all.mjs"]
