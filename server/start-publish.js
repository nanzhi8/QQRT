#!/usr/bin/env node
// 生产启动脚本：加载 .env、绑定 0.0.0.0:$PORT，供发布平台单端口托管使用。
// 发布平台会注入 PORT 环境变量；未注入时回退 3005。
const fs = require("fs");
const path = require("path");

// 轻量 .env 加载（不依赖 dotenv，避免运行时缺失）
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

// 把随项目安装的 ffmpeg/ffprobe 加进 PATH（处理手表图片/语音需要）。
// 用安装包导出的 path 解析，Windows / Linux / macOS 通用（Linux 上包名是 linux-x64）。
for (const pkg of ["@ffmpeg-installer/ffmpeg", "@ffprobe-installer/ffprobe"]) {
  try {
    const info = require(pkg);
    const dir = info && info.path ? path.dirname(info.path) : "";
    if (dir && fs.existsSync(dir)) {
      const parts = (process.env.PATH || "").split(path.delimiter);
      if (!parts.includes(dir)) process.env.PATH = dir + path.delimiter + (process.env.PATH || "");
    }
  } catch {
    /* 未安装则忽略，服务端会退化为不支持图片/语音 */
  }
}

// 发布平台注入的 PORT 优先；.env 里的 PORT 已在上面被跳过（存在则不覆盖）
const port = process.env.PORT || "3005";
process.env.PORT = port;
// 发布到根域名
process.env.NEXT_PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

const { spawn } = require("child_process");
// 用当前进程的 node 可执行文件绝对路径启动 Next。
// 不要写 "node"：双击 .cmd 时 cmd 的 PATH 里可能没有 node（Explorer 未刷新环境变量），
// 会以 spawn node ENOENT 直接失败。
const child = spawn(
  process.execPath,
  [path.join(__dirname, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "0.0.0.0", "-p", port],
  { cwd: __dirname, stdio: "inherit", env: process.env },
);

child.on("exit", (code) => process.exit(code == null ? 0 : code));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
