import type { NextConfig } from "next";

// 与 src/lib/api.ts 的 NEXT_PUBLIC_BASE_PATH 保持一致：
// 若部署在子路径（例如 /qqbot），Next.js 自身的路由 /静态资源也要带上该前缀，
// 否则浏览器端 pathOf() 拼了 /qqbot 前缀但服务端资源仍在根路径，会 404。
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  basePath: basePath || undefined,
  // PGlite 带 WASM 与文件系统访问，必须当外部包，不能被打包器内联
  serverExternalPackages: [
    "@electric-sql/pglite",
    // QQ 机器人 SDK 必须走真实 node_modules：
    // 被 webpack 打包时 ws 会被替换成 Next 内置的精简版，缺少 mask()，
    // 发送 IDENTIFY 帧时报「b.mask is not a function」，机器人连不上。
    "@tencent-connect/qqbot-nodejs",
    "ws",
  ],
  // NEXT_STANDALONE=1 时产出可独立运行的 server.js（托管环境不装依赖）
  output: process.env.NEXT_STANDALONE === "1" ? "standalone" : undefined,
};

export default nextConfig;
