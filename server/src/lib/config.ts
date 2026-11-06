import fs from "node:fs";
import path from "node:path";

/**
 * 运行时配置：所有可调项都来自环境变量，方便服务器部署。
 */
const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));

export const config = {
  dataDir,
  logLevel: (process.env.LOG_LEVEL || "info").toLowerCase(),
  mediaDir: path.join(dataDir, "media"),
  outDir: path.join(dataDir, "media", "out"),
  inDir: path.join(dataDir, "media", "in"),
  gatewayDir: path.join(dataDir, "gateway"),
  secretKeyPath: path.join(dataDir, "secret.key"),
  /** 手表（240x240 屏幕）专用媒体目录。 */
  watchDir: path.join(dataDir, "media", "watch"),
  /** 手表文本查看器临时目录（清洗后的纯中文/字母文本）。 */
  watchTextDir: path.join(dataDir, "media", "watch-text-tmp"),
  /** 手表图片输出边长（px）。 */
  watchImageSize: 240,
  /** 手表视频单段最大时长（秒）。手表系统播放器不能播放超过 59 秒的视频。
   *  bug#12：58 会在 ffprobe 取整后产出 59s 临界段，对齐参考项目降到 55（留足余量）。
   *  bug#12 终版：GOP 改为帧率×5（复刻参考项目实测可播规格）后，segment 复用器
   *  只在关键帧（每 5s 一个）处切段，实际段长会浮到 55~60s —— 60s 已触顶官方
   *  59s 上限（mediapipe 实测 60,55,15）。标称段长再降到 50，实际段长 50~55s，
   *  永远 <59s；编码参数与参考项目逐项一致不动。 */
  watchVideoMaxSec: 50,
  /** 浏览器上传单文件上限（字节），默认 200MB。 */
  maxUploadBytes: (Number(process.env.MAX_UPLOAD_MB) || 200) * 1024 * 1024,
  /** 两次自动同步之间的最小间隔（毫秒），避免频繁调用开放平台接口。 */
  syncMinIntervalMs: 20_000,
  /** 被动回复（带引用）允许的最大消息年龄（毫秒），超过则改为主动消息。 */
  passiveReplyWindowMs: 4.5 * 60 * 1000,
} as const;

export function ensureDirs(): void {
  for (const dir of [
    config.dataDir,
    config.mediaDir,
    config.outDir,
    config.inDir,
    config.gatewayDir,
    config.watchDir,
    config.watchTextDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
