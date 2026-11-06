# QQRT 服务端镜像
# 构建上下文是上一级目录（qqrt-server），不是本目录：
#   cd qqrt-server
#   docker build -f deploy/Dockerfile -t qqrt-server .

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* .npmrc* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3005 \
    TZ=Asia/Shanghai

# 运行期只需要构建产物 + 依赖 + 启动脚本
# 系统 ffmpeg：ARM 主机（Oracle 免费 ARM 实例）上 npm 的 ffmpeg 包可能没有对应架构，
# 装系统包最稳；start-publish.js 会优先用 npm 包，找不到就用 PATH 里的
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/start-publish.js ./start-publish.js
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/next.config.ts ./next.config.ts

# data/ 存 AppSecret 加密密钥，必须挂卷，否则重建容器后旧密钥解不开
VOLUME ["/app/data"]

EXPOSE 3005
CMD ["node", "start-publish.js"]
