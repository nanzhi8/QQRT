const fs = require("node:fs");
const path = require("node:path");

/**
 * 读取应用目录下的 .env。
 *
 * 关键：PM2 **不会**自动加载 .env（只有 Next.js 自己会）。原实现直接读
 * `process.env.PORT`，导致用户在 .env 里改端口后，PM2 仍然按默认 3004 启动，
 * 与 nginx 反代端口不一致。这里显式解析 .env，保证端口以 .env 为准。
 */
function loadEnvFile(file) {
  const out = {};
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch {
    /* 没有 .env 时退回默认值 */
  }
  return out;
}

const envFile = loadEnvFile(path.join(__dirname, ".env"));

const PORT = String(process.env.PORT || envFile.PORT || "3004");
const DATA_DIR = process.env.DATA_DIR || envFile.DATA_DIR || path.join(__dirname, "data");
const DATABASE_URL = process.env.DATABASE_URL || envFile.DATABASE_URL || "";

module.exports = {
  apps: [
    {
      name: "qqwatchtest",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: `start -p ${PORT}`,
      // 低配服务器：目标是把整个进程 RSS 压在 250MB 以内。
      // 192MB 堆上限 + V8 常规开销（新生代/external/code）≈ RSS 220~245MB，
      // 留有余量；低于 160MB 时 Next.js 16 生产运行时容易 OOM 重启，故取 192。
      // 如你的机器更紧张，可下调到 160；更宽裕可上调到 256。
      node_args: "--max-old-space-size=192",
      env: {
        NODE_ENV: "production",
        PORT,
        DATA_DIR,
        ...(DATABASE_URL ? { DATABASE_URL } : {}),
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 8000,
      // 日志写到应用目录 logs/ 下，避免依赖固定 /root 路径（兼容非 root 部署）
      out_file: path.join(__dirname, "logs", "qqwatchtest-out.log"),
      error_file: path.join(__dirname, "logs", "qqwatchtest-error.log"),
      merge_logs: true,
    },
  ],
};
