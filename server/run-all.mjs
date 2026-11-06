#!/usr/bin/env node
/**
 * 一键启动：同步表结构 → 启动 Web/API 服务
 * ------------------------------------------------------------
 * 数据库是进程内 PGlite（PostgreSQL 18 WASM），不再需要单独的数据库进程，
 * 数据目录由 PGLITE_DIR 指定（默认 ./pgdata）。
 *
 * 环境变量：PORT / PGLITE_DIR / SKIP_MIGRATE=1（跳过建表）
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const dir = path.dirname(fileURLToPath(import.meta.url));
const log = (msg) => console.log(`[qqrt] ${msg}`);

// 把随项目安装的 ffmpeg/ffprobe 加进 PATH（处理手表图片/语音需要）。
// 用安装包导出的 path 解析，Windows / Linux / macOS 通用。
const nodeRequire = createRequire(import.meta.url);
const ffDirs = [];
for (const pkg of ["@ffmpeg-installer/ffmpeg", "@ffprobe-installer/ffprobe"]) {
  try {
    const info = nodeRequire(pkg);
    const d = info && info.path ? path.dirname(info.path) : "";
    if (d && fs.existsSync(d)) ffDirs.push(d);
  } catch {
    /* 未安装则忽略，退化为不支持图片/语音 */
  }
}
if (ffDirs.length) {
  process.env.PATH = ffDirs.join(path.delimiter) + path.delimiter + (process.env.PATH || "");
  log("ffmpeg: " + ffDirs.map((d) => d.replace(/\\/g, "/")).join("  |  "));
}

const webPort = Number(process.env.PORT || 3005);
const dataDir = path.resolve(dir, process.env.PGLITE_DIR || "./pgdata");
log(`PGlite 数据目录：${dataDir}`);

// ---------- 1. 建表 ----------
const drizzleBin = path.join(dir, "node_modules", "drizzle-kit", "bin.cjs");
if (process.env.SKIP_MIGRATE === "1") {
  log("SKIP_MIGRATE=1，跳过建表");
} else if (!fs.existsSync(drizzleBin)) {
  log("未安装 drizzle-kit，跳过建表（生产安装可设 SKIP_MIGRATE=1 消除本提示）");
} else {
  log("同步数据库表结构 …");
  const code = await new Promise((resolve) => {
    const mig = spawn(process.execPath, [drizzleBin, "push", "--force"], {
      cwd: dir,
      stdio: "inherit",
      env: { ...process.env, PGLITE_DIR: dataDir },
    });
    mig.on("exit", (c) => resolve(c ?? 1));
    mig.on("error", () => resolve(1));
  });
  if (code === 0) log("表结构已同步");
  else log(`建表失败（exit ${code}），可手动执行：npx drizzle-kit push --force`);
}

// ---------- 2. 启动 Web ----------
log(`启动 Web 服务 0.0.0.0:${webPort} …`);
const web = spawn(process.execPath, [path.join(dir, "start-publish.js")], {
  cwd: dir,
  stdio: "inherit",
  env: { ...process.env, PORT: String(webPort) },
});

web.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try { web.kill(sig); } catch { /* ignore */ }
  });
}
