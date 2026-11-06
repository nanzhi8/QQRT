import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { config, ensureDirs } from "@/lib/config";
import { AppError, appError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { cacheInbound, getCached } from "./media";
import type { AttachmentMeta, MessageRow } from "@/db/schema";

/**
 * 手表媒体管道（240x240 / 内存与流量受限设备专用）。
 *
 * QQ 入站附件先复用 media.ts 的代理缓存（避免 QQ CDN 过期/鉴权问题），再按
 * 手表能解码的格式统一转码：
 * - 图片：等比缩放到 240x240 以内（不裁切、不变形），转 PNG / JPEG。
 * - 语音：转成 MP3（silk / 任意音频均可），供 system.audio 播放。
 * - 视频：转成 H.264 baseline MP4，等比缩放到 240x240 以内，并按
 *   config.watchVideoMaxSec（默认 58 秒）切成多段 —— 因为手表系统播放器
 *   不能播放超过 59 秒的视频。
 *
 * 所有产物按 `messageId-index` 落盘缓存，重复请求直接命中，避免重复转码。
 */

const execFileAsync = promisify(execFile);

/**
 * bug#2 修复：H.264 编码器自适应。
 *
 * 原实现把视频编码器硬编码为 `libx264`。但不同 ffmpeg 构建差异极大：
 * 官方静态构建常常 `--disable-libx264`（本机实测即如此），只有 `libopenh264`；
 * 而 `libopenh264` **不接受** `-profile:v` / `-level` 参数（会直接报
 * "Error applying encoder options: Invalid argument"）。于是只要部署环境的
 * ffmpeg 不含 libx264，「任何视频都转码失败」——正是用户反馈的
 * 「视频发过来不能稳定转码/播放」。
 *
 * 修法：探测本机可用的 H.264 编码器并按优先级回退：
 *   libx264(全功能) → libopenh264(基线可用) → h264(原生) → mpeg4(最后兜底)
 * 并记录该编码器是否支持 `-profile:v/-level` 参数，构造命令时按需添加。
 */
interface VideoEncoder {
  name: string;
  supportsProfileFlags: boolean;
}
let cachedEncoder: VideoEncoder | null | undefined;

function probeVideoEncoder(): VideoEncoder | null {
  if (cachedEncoder !== undefined) return cachedEncoder;
  let list = "";
  try {
    list = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    list = "";
  }
  const has = (name: string) => new RegExp(`(^|\\s)${name}(\\s|$)`, "m").test(list);
  if (has("libx264")) cachedEncoder = { name: "libx264", supportsProfileFlags: true };
  else if (has("libopenh264")) cachedEncoder = { name: "libopenh264", supportsProfileFlags: false };
  else if (has("h264")) cachedEncoder = { name: "h264", supportsProfileFlags: false };
  else if (has("mpeg4")) cachedEncoder = { name: "mpeg4", supportsProfileFlags: false };
  else cachedEncoder = null;
  if (cachedEncoder) log.info("watch video encoder selected", { encoder: cachedEncoder.name });
  else log.warn("no usable H.264 encoder found in ffmpeg; video transcode will fail");
  return cachedEncoder;
}

/** 为视频转码构造编码参数（按编码器能力裁剪不兼容的开关）。
 *
 * bug#12 修复（第七轮「分段能选但系统播放器拉不起」）：
 *   完全复刻抖音RT参考项目服务端（douyin-server/lib/transcode.js，
 *   用户实测手表可播）的转码规格，不再自行发明参数：
 *   - libopenh264 显式 `-profile:v constrained_baseline`（ffmpeg 为 openh264
 *     提供的专属枚举名，写成 baseline 会报 "Unable to parse"）+ `-level 4.1`。
 *   - `-coder 0`（openh264）/`-coder 1`（x264）= CAVLC 熵编码，解码更简单。
 *   - yuv420p / -bf 0 / 420k-520k-1040k 码率 —— 与参考项目逐项一致。
 *   - GOP = 帧率 × 5（参考项目关键帧 5s 一个；segment 切割点必为 IDR，
 *     每段开头仍有即时起播关键帧，段内 5s GOP 降码率峰值、稳住弱解码器）。
 *   - 帧率 30fps：用户指定（手表相机原片同为 30fps，兼容无虞；
 *     参考项目用 24 系其源站约束，非兼容性要求）。
 *   - 音频 AAC-LC 16000Hz 单声道 64k：与参考项目一致（原 22050Hz 半采样率
 *     疑似不被手表 AAC 解码器支持，是拉不起播放器的头号嫌疑）。
 *   - 容器侧：-reset_timestamps 1 / -avoid_negative_ts make_zero /
 *     segment_format_options movflags=+faststart —— 见下方主命令，已一致。 */
function videoCodecArgs(): string[] {
  const enc = probeVideoEncoder();
  if (!enc) throw appError("MEDIA_ERROR", "服务器缺少视频编码器", "请联系管理员安装含 H.264 的 ffmpeg");
  const args = ["-c:v", enc.name];
  if (enc.name === "libopenh264") {
    args.push("-profile:v", "constrained_baseline", "-level", "4.1", "-coder", "0");
  } else if (enc.supportsProfileFlags) {
    args.push("-profile:v", "baseline", "-level", "4.1", "-coder", "1");
  }
  // 兼容性加固（与参考项目一致）：
  //  - yuv420p：唯一被普遍支持的色度格式
  //  - 关闭 B 帧（baseline 本就无 B 帧，显式 -bf 0 兜底）
  //  - 关键帧间隔 = 帧率 × 5（5 秒一个 IDR，复刻参考项目实测可播规格）
  args.push("-pix_fmt", "yuv420p", "-bf", "0", "-r", "30", "-g", "150", "-keyint_min", "150", "-sc_threshold", "0");
  args.push("-b:v", "420k", "-maxrate", "520k", "-bufsize", "1040k");
  return args;
}

/**
 * 同一 `messageId-index` 的转码互斥锁：避免两个请求同时跑 ffmpeg 写同一批
 * 产物文件（视频分段 / 图片 / 音频），导致文件互相覆盖或读到半成品。
 */
const inflight = new Map<string, Promise<unknown>>();

function withInflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export interface WatchImage {
  path: string;
  contentType: string;
  size: number;
  width: number;
  height: number;
}

export interface WatchVideoSegment {
  /** 相对 URL，例如 /api/watch/video-file/xxx/0/seg_000.mp4 */
  url: string;
  index: number;
  /** 该段时长（秒），供端侧显示「第 N 段 · XXs」；探测失败为 0。 */
  duration?: number;
}

export interface WatchVideo {
  segments: WatchVideoSegment[];
  count: number;
  durationSec: number;
  width: number;
  height: number;
}

export interface WatchAudio {
  path: string;
  contentType: string;
  size: number;
  /** 语音识别文字（QQ 下发的 ASR 结果）。 */
  asrText?: string | null;
}

function safePart(value: string): string {
  return value.replace(/[^0-9a-zA-Z-]/g, "").slice(0, 120);
}

/**
 * 端侧媒体格式版本号。**只要转码参数/容器格式发生不向后兼容的变化就必须 +1**，
 * 否则老部署升级后仍会命中旧缓存，把老格式（如 level 3.0 / 非宏块对齐的 H.264）
 * 继续喂给手表 —— 用户侧表现为「升级了也没修好」。
 *
 * 变更历史：
 *   v1 → v2（bug#11/#10）：H.264 改为 16 像素宏块对齐 + 无 B 帧；
 *                          音频统一转单声道 22050Hz MP3 并做魔数校验。
 *   v2 → v3（bug#12）：视频对齐参考项目可播规格 —— openh264 显式
 *         constrained_baseline/level 4.1/CAVLC、30fps、420k 码率；
 *         音频改 16000Hz AAC-LC 64k（22050 半采样率疑似不被手表解码器支持）；
 *         滤镜强制 setsar=1；segment 增加 -avoid_negative_ts make_zero。
 *   v3 → v4（bug#12 终版）：GOP 由 1s 改为 5s（帧率×5），逐项复刻抖音RT
 *         参考项目服务端 transcode.js 的实测可播参数（其余项 v3 已对齐）。
 *   v4 → v5（bug#12 收尾）：GOP=5s 后 segment 只在关键帧切段，段长浮到
 *         55~60s 触顶官方 59s 上限（mediapipe 实测 60,55,15）。标称段长
 *         watchVideoMaxSec 55 → 50，实际段长 50~55s 恒 <59s。
 */
const WATCH_FORMAT_VERSION = 5;

function watchBase(messageId: string, index: number): string {
  return path.join(config.watchDir, `${safePart(messageId)}-${index}`);
}

/** 把 QQ 附件拉到本地（命中缓存则直接返回）。出站媒体（bot 自己发的）没有 CDN URL，
 * 但本地 outDir 里有原始上传文件，可直接读取转发给手表显示。 */
async function ensureLocal(message: MessageRow, index: number, att: AttachmentMeta): Promise<{ path: string; contentType: string }> {
  const cached = getCached(message.id, index);
  if (cached) return { path: cached.path, contentType: cached.contentType };
  // 出站消息：附件只有 localId，原始文件已保存在 outDir。
  if (!att.url && att.localId) {
    const { outPathFor } = await import("./media");
    const localPath = outPathFor(att.localId);
    if (localPath) {
      return { path: localPath, contentType: att.contentType || "application/octet-stream" };
    }
  }
  if (!att.url) throw appError("INVALID_REQUEST", "该附件没有下载地址", "");
  let getToken: (() => Promise<string>) | undefined;
  try {
    const { requireBot } = await import("./botManager");
    const bot = requireBot(message.userId);
    getToken = () => bot.api.getToken();
  } catch {
    /* 机器人离线时尝试匿名下载 */
  }
  const got = await cacheInbound(message.id, index, att.url, att.contentType, getToken);
  return { path: got.path, contentType: got.contentType };
}

// ── 图片 ──────────────────────────────────────────────────────────────────

export async function processWatchImage(message: MessageRow, index: number, att: AttachmentMeta): Promise<WatchImage> {
  return withInflight(`i:${message.id}:${index}`, async () => processWatchImageInner(message, index, att));
}

async function processWatchImageInner(message: MessageRow, index: number, att: AttachmentMeta): Promise<WatchImage> {
  ensureDirs();
  const base = watchBase(message.id, index);
  const metaPath = `${base}.image.json`;

  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
        path: string; contentType: string; width: number; height: number; size: number;
      };
      if (meta.path && fs.existsSync(meta.path) && meta.size <= 100 * 1024) {
        return { path: meta.path, contentType: meta.contentType, size: fs.statSync(meta.path).size, width: meta.width, height: meta.height };
      }
    } catch {
      /* stale cache: rebuild */
    }
  }

  const local = await ensureLocal(message, index, att);
  const tmpBase = `${base}.tmp-${Date.now()}`;
  const maxBytes = 100 * 1024; // 官方框架限制：单张图片超过 100KB 会下载失败。
  const size = config.watchImageSize;
  const scaleExpr = `scale='max(2,trunc(iw*min(min(1,${size}/iw),${size}/ih)/2)*2)':'max(2,trunc(ih*min(min(1,${size}/iw),${size}/ih)/2)*2)'`;

  const probeSize = async (filePath: string): Promise<{ width: number; height: number }> => {
    try {
      const probe = await execFileAsync("ffprobe", [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", filePath,
      ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      const [w, h] = probe.stdout.trim().split("x").map(Number);
      if (w > 0 && h > 0) return { width: w, height: h };
    } catch { /* use attachment dimensions below */ }
    const srcW = Number(att.width) || size;
    const srcH = Number(att.height) || size;
    const scale = Math.min(1, size / Math.max(srcW, srcH, 1));
    return { width: Math.max(1, Math.round(srcW * scale)), height: Math.max(1, Math.round(srcH * scale)) };
  };

  const candidates: Array<{ ext: string; contentType: string; args: string[] }> = [];
  const mime = (local.contentType || "").toLowerCase();
  const preferPng = mime === "image/png" || mime === "image/x-png" || mime === "image/gif";
  if (preferPng) {
    candidates.push({
      ext: ".png", contentType: "image/png",
      args: ["-y", "-i", local.path, "-vf", scaleExpr, "-frames:v", "1", "-compression_level", "9", "-f", "image2"],
    });
  }
  // JPEG 是手表最省空间的照片格式，也是 100KB 上限下的最终兜底格式。
  candidates.push({
    ext: ".jpg", contentType: "image/jpeg",
    args: ["-y", "-i", local.path, "-vf", scaleExpr, "-frames:v", "1", "-q:v", "6", "-f", "image2"],
  });

  try {
    for (const candidate of candidates) {
      const outPath = `${base}${candidate.ext}`;
      for (const q of candidate.ext === ".jpg" ? [6, 8, 10, 12, 15, 18, 22] : [9]) {
        const tmp = `${tmpBase}${candidate.ext}`;
        const args = candidate.args.slice();
        if (candidate.ext === ".jpg") {
          const qIndex = args.indexOf("-q:v");
          if (qIndex >= 0) args[qIndex + 1] = String(q);
        }
        args.push(tmp);
        try {
          await execFileAsync("ffmpeg", args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
          const bytes = fs.statSync(tmp).size;
          if (bytes <= maxBytes) {
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
            fs.renameSync(tmp, outPath);
            const dims = await probeSize(outPath);
            const actualSize = fs.statSync(outPath).size;
            fs.writeFileSync(metaPath, JSON.stringify({ path: outPath, contentType: candidate.contentType, width: dims.width, height: dims.height, size: actualSize }));
            return { path: outPath, contentType: candidate.contentType, size: actualSize, width: dims.width, height: dims.height };
          }
        } finally {
          try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
        }
      }
    }
    throw new Error("图片压缩后仍超过 100KB");
  } catch (e) {
    log.warn("watch image process failed", e);
    // 不再把超出官方 100KB 限制的原图直接交给手表；宁可明确失败，也不返回一个必然下载失败的文件。
    throw appError("MEDIA_ERROR", "图片处理失败", "图片过大或格式不兼容，请稍后重试");
  } finally {
    try { if (fs.existsSync(tmpBase + ".png")) fs.unlinkSync(tmpBase + ".png"); } catch {}
    try { if (fs.existsSync(tmpBase + ".jpg")) fs.unlinkSync(tmpBase + ".jpg"); } catch {}
  }
}

// ── 语音 ──────────────────────────────────────────────────────────────────

export async function processWatchAudio(message: MessageRow, index: number, att: AttachmentMeta): Promise<WatchAudio> {
  return withInflight(`a:${message.id}:${index}`, async () => processWatchAudioInner(message, index, att));
}

async function processWatchAudioInner(message: MessageRow, index: number, att: AttachmentMeta): Promise<WatchAudio> {
  ensureDirs();
  const outPath = `${watchBase(message.id, index)}.mp3`;
  if (fs.existsSync(outPath)) {
    // bug#10 部署修复：老缓存可能是「把 SILK 当 MP3 透传」的产物（后缀 .mp3、
    //   内容却不是真 MP3）。命中缓存前先验魔数，非真 MP3 一律丢弃重转。
    try {
      if (sniffAudioMagic(outPath) === "audio/mpeg") {
        return { path: outPath, contentType: "audio/mpeg", size: fs.statSync(outPath).size, asrText: att.asrText };
      }
      log.warn("watch audio cache is not a real mp3, re-transcoding", { messageId: message.id, index });
      safeUnlink(outPath);
    } catch {
      safeUnlink(outPath);
    }
  }

  // bug#10 修复：QQ 语音的真实编码是 SILK（#!SILK_V3），QQ CDN 却把下载响应的
  //   Content-Type 谎报为 audio/mp3。旧实现直接信这个头，ffmpeg 解不了 SILK 后
  //   又按「ct 含 mpeg 就透传」把 SILK 当 MP3 返回，手表 system.audio 自然播不了。
  //   现在：
  //     1) 优先用 QQ 已转好的 voiceWavUrl（WAV，最稳）；
  //     2) 否则回退下载原始文件；
  //     3) 转码失败时用**文件魔数**而不是 Content-Type 判断能否透传，
  //        只有真的是 mp3/wav/ogg/m4a 才允许透传，其余一律报错，绝不再谎报。
  const sources: Array<{ path: string; cleanup?: () => void }> = [];
  if (att.voiceWavUrl) {
    try {
      const wavPath = await downloadToTemp(att.voiceWavUrl, `${outPath}.src.wav`);
      sources.push({ path: wavPath, cleanup: () => safeUnlink(wavPath) });
    } catch (e) {
      log.warn("voiceWavUrl download failed, fallback to raw attachment", e);
    }
  }
  const local = await ensureLocal(message, index, att);
  sources.push({ path: local.path });

  let lastErr: unknown = null;
  for (const src of sources) {
    const tmp = `${outPath}.tmp-${Date.now()}`;
    try {
      await execFileAsync(
        "ffmpeg",
        ["-y", "-i", src.path, "-vn", "-ac", "1", "-ar", "22050", "-b:a", "48k", "-f", "mp3", tmp],
        { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      );
      fs.renameSync(tmp, outPath);
      if (src.cleanup) src.cleanup();
      return { path: outPath, contentType: "audio/mpeg", size: fs.statSync(outPath).size, asrText: att.asrText };
    } catch (e) {
      lastErr = e;
      safeUnlink(tmp);
      log.warn(`watch audio transcode failed for ${src.path}`, e);
    }
  }
  if (sources[0] && sources[0].cleanup) sources[0].cleanup();

  // 转码全部失败：仅当原始文件**确实**是手表能直接播的格式时才透传。
  const magic = sniffAudioMagic(local.path);
  if (magic) {
    return { path: local.path, contentType: magic, size: fs.statSync(local.path).size, asrText: att.asrText };
  }
  log.warn("watch audio unusable after transcode fallback", lastErr);
  throw appError("MEDIA_ERROR", "语音转换失败", "请稍后重试");
}

/** 读取文件头判断真实容器；返回可直接交给 system.audio 的 MIME，无法识别返回 null。 */
function sniffAudioMagic(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    if (n < 4) return null;
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return "audio/mpeg"; // ID3
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "audio/mpeg"; // MPEG frame sync
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
    if (buf.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
    if (buf.toString("ascii", 4, 8) === "ftyp") return "audio/mp4"; // m4a
    // SILK / AMR：手表无法解码，明确拒绝透传。
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function safeUnlink(p: string): void {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/** 把远端音频（如 QQ 的 voiceWavUrl）下载到本地临时文件。 */
async function downloadToTemp(url: string, dest: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`下载失败: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("下载为空");
  fs.writeFileSync(dest, buf);
  return dest;
}

// ── 视频 ──────────────────────────────────────────────────────────────────

function listSegments(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^seg_\d{3}\.mp4$/.test(f))
    .sort();
}

export async function processWatchVideo(message: MessageRow, index: number, att: AttachmentMeta): Promise<WatchVideo> {
  return withInflight(`v:${message.id}:${index}`, async () => processWatchVideoInner(message, index, att));
}

async function processWatchVideoInner(message: MessageRow, index: number, att: AttachmentMeta): Promise<WatchVideo> {
  ensureDirs();
  const base = watchBase(message.id, index);
  const manifestPath = `${base}.video.json`;
  const dir = `${base}-v`;
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Omit<WatchVideo, "segments"> & { segments: Array<{ url: string; index: number }>; formatVersion?: number };
      // bug#11/#10 部署修复：老缓存没有 formatVersion（或版本落后）说明是旧转码
      // 参数产出的文件，必须丢弃重转，否则升级后仍播不了。
      if (m.formatVersion !== WATCH_FORMAT_VERSION) {
        log.warn("watch video cache format outdated, re-transcoding", { messageId: message.id, index, got: m.formatVersion, want: WATCH_FORMAT_VERSION });
      } else {
        // 缓存清单必须校验分段文件仍然存在：媒体目录可能被清理/迁移，
        // 只信清单会让手表拿到 404 的分段地址。
        const onDisk = listSegments(dir);
        if (onDisk.length === m.count && onDisk.length === m.segments.length) {
          return { segments: m.segments, count: m.count, durationSec: m.durationSec, width: m.width, height: m.height };
        }
        log.warn("watch video manifest stale, re-transcoding", { messageId: message.id, index });
      }
    } catch {
      /* 清单损坏：重新转码 */
    }
  }

  const local = await ensureLocal(message, index, att);
  fs.mkdirSync(dir, { recursive: true });
  const segPattern = path.join(dir, "seg_%03d.mp4");
  const size = config.watchImageSize;
  const maxSec = config.watchVideoMaxSec;

  // 探测原始时长（失败则置 0，手表端不依赖该值）。
  let durationSec = 0;
  try {
    const out = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      local.path,
    ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    durationSec = Math.max(0, Math.round(Number(out.stdout.trim()) || 0));
  } catch {
    /* ffprobe 不可用 */
  }

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      local.path,
      "-vf",
      // bug#11：宽高按 **16 像素宏块对齐**（H.264 要求 16x16 宏块；240x240 正好 15x15）。
      //   旧实现只对齐到 2，会产出 134x240 这类非宏块对齐尺寸，
      //   弱硬件解码器可能拒绝或花屏。这里先等比缩放到 ≤240，再向下取整到 16 的倍数，
      //   并保证最小 16，避免出现 0/负数尺寸。
      // bug#12：追加 setsar=1 —— 非 1:1 采样纵横比的源会导致部分固件解码器花屏/拒绝。
      `scale='max(16,floor(iw*min(min(1,${size}/iw),${size}/ih)/16)*16)':'max(16,floor(ih*min(min(1,${size}/iw),${size}/ih)/16)*16)',setsar=1`,
      // bug#2：编码器按部署环境自适应（libx264 → libopenh264 → h264 → mpeg4）。
      ...videoCodecArgs(),
      // bug#12：音频对齐参考项目可播规格 —— 16000Hz 单声道 AAC-LC。
      //   22050Hz 半采样率在部分手表 AAC 解码器上不被支持（拉不起播放器的头号嫌疑）。
      "-c:a",
      "aac",
      "-profile:a",
      "aac_low",
      "-b:a",
      "64k",
      "-ar",
      "16000",
      "-ac",
      "1",
      // 注意：`-movflags +faststart` 对 `-f segment` 是无效的（该 flag 会被
      // 忽略，moov 仍写在文件尾部）。必须通过 segment 复用器的
      // `-segment_format_options` 透传给 mp4 复用器才真正生效。
      "-f",
      "segment",
      "-segment_time",
      String(maxSec),
      "-reset_timestamps",
      "1",
      // bug#12：强制时间戳从 0 开始 —— 某些固件播放器对非零/负起始 PTS 的
      // 分段 mp4 会直接拒绝初始化（表现为拉不起播放器）。
      "-avoid_negative_ts",
      "make_zero",
      "-segment_format",
      "mp4",
      "-segment_format_options",
      "movflags=+faststart",
      segPattern,
    ],
    { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 },
  );

  const segs = listSegments(dir);
  if (segs.length === 0) {
    // 视频极短（不足一段）时 segment 可能只输出一个文件；兜底用单文件重转。
    throw appError("MEDIA_ERROR", "视频分段失败", "请稍后重试");
  }

  // 视频分辨率：用 ffprobe 读取第一段的分辨率，失败则用 240。
  let width = 240;
  let height = 240;
  try {
    const probe = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=s=x:p=0",
      path.join(dir, segs[0]),
    ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const [w, h] = probe.stdout.trim().split("x").map(Number);
    if (w > 0 && h > 0) {
      width = w;
      height = h;
    }
  } catch {
    /* ignore */
  }

  // 分段时长：逐段 ffprobe，供手表端「第 N 段 · XXs」精确展示。
  // 分段是真实文件，探测很快；任何一段探测失败就退化为 0（端侧会显示为 1s 兜底）。
  const segDurations: number[] = [];
  for (const f of segs) {
    let d = 0;
    try {
      const p = await execFileAsync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", path.join(dir, f),
      ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      d = Math.max(0, Math.round(Number(p.stdout.trim()) || 0));
    } catch {
      d = 0;
    }
    segDurations.push(d);
  }

  const manifest = {
    segments: segs.map((f, i) => ({
      url: `/api/watch/video-file/${safePart(message.id)}/${index}/${i}`,
      index: i,
      duration: segDurations[i] ?? 0,
    })),
    count: segs.length,
    durationSec,
    width,
    height,
    formatVersion: WATCH_FORMAT_VERSION,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return manifest;
}

/** 读取单个视频分段的文件路径（供 /api/watch/video-file 使用）。 */
export function watchVideoSegmentPath(message: MessageRow, index: number, seg: number): string | null {
  const dir = `${watchBase(message.id, index)}-v`;
  const file = path.join(dir, `seg_${String(seg).padStart(3, "0")}.mp4`);
  try {
    if (fs.existsSync(file)) return file;
    return null;
  } catch {
    return null;
  }
}

/** 判断附件在手表端属于哪种媒体。 */
export function watchMediaKind(att: AttachmentMeta): "image" | "video" | "audio" | "text" | "file" {
  const ct = (att.contentType || "").toLowerCase();
  const name = (att.filename || "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  // bug#14（第八轮）：QQ「文件方式」发来的图片/视频，contentType 一律是字面量
  //   "file"（非 MIME），只有 filename 可判（且扩展名常为大写，如 .MP4 —— name 已
  //   lowercase）。没有扩展名兜底时会落到 "file"，手表端点开只给原始文件下载，
  //   图片/视频全部无法显示/播放。这里按扩展名兜底识别（name 已小写）。
  if (/\.(jpg|jpeg|png|webp|bmp|gif|heic|heif)$/.test(name)) return "image";
  if (/\.(mp4|mov|m4v|3gp|3gpp|avi|mkv|webm)$/.test(name)) return "video";
  // 音乐文件（mp3/flac/m4a/aac/wav/ogg 等）本质是音频：交给 system.audio 播放。
  // 注意：QQ 的 "voice" 语音也走同一分支，两者在手表端都用 system.audio。
  if (ct === "voice" || ct.includes("audio") || ct.includes("silk") || ct.includes("mpeg")) return "audio";
  if (/\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|wma|amr)$/.test(name)) return "audio";
  // 纯文本文件可以在手表上直接阅读。
  if (ct.startsWith("text/") || /\.(txt|md|log|json|csv|ini|conf|xml|html?)$/.test(name)) return "text";
  return "file";
}

/** 手表能直接阅读的文本：抽取出来并做长度与编码兜底（bug#13）。 */
export async function readWatchText(att: AttachmentMeta, message: MessageRow, index: number): Promise<{ filename: string; text: string }> {
  const local = await ensureLocal(message, index, att);
  const filename = att.filename || `file-${index + 1}`;
  const MAX = 20 * 1024; // 只读前 20KB，避免把大日志塞进 128MB 内存的手表
  try {
    const fd = fs.openSync(local.path, "r");
    try {
      const buf = Buffer.alloc(MAX);
      const read = fs.readSync(fd, buf, 0, MAX, 0);
      const slice = buf.subarray(0, read);
      // 常见中文文本是 UTF-8；若出现大量替换字符则按 GBK 再解一次。
      let text = slice.toString("utf8");
      const bad = (text.match(/\uFFFD/g) || []).length;
      if (bad > read / 50 && read > 0) {
        try {
          const dec = new TextDecoder("gbk");
          text = dec.decode(slice);
        } catch {
          /* 解码器不可用时保留 utf8 结果 */
        }
      }
      const clean = normalizeWatchText(text.replace(/\u0000/g, ""));
      try {
        writeWatchTextTemp(message.id, index, clean);
      } catch {
        /* 临时文件写入失败不影响返回 */
      }
      return { filename, text: clean };
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    log.warn("watch text read failed", e);
    throw appError("MEDIA_ERROR", "文本读取失败", "该文件无法作为文本打开");
  }
}

/** 只保留手表文本查看器能稳定显示的中文、字母、数字和基础标点/换行。 */
export function normalizeWatchText(raw: string): string {
  return String(raw || "")
    .replace(/[^\u4e00-\u9fffA-Za-z0-9\s.,!?;:，。！？；：、（）()\-_/]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function writeWatchTextTemp(messageId: string, index: number, text: string): string {
  ensureDirs();
  const safeId = messageId.replace(/[^0-9a-zA-Z-]/g, "").slice(0, 80);
  const p = path.join(config.watchTextDir, `${safeId}-${index}-${Date.now()}.txt`);
  fs.writeFileSync(p, text, "utf8");
  return p;
}

export function cleanupWatchTextTemp(): void {
  try {
    if (!fs.existsSync(config.watchTextDir)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(config.watchTextDir)) {
      if (!name.endsWith(".txt")) continue;
      const p = path.join(config.watchTextDir, name);
      try {
        if (now - fs.statSync(p).mtimeMs > 5 * 60 * 1000) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * 取「原图」：服务器**不压缩**，但必须保证手表能解析且不超过 100KB 硬限制（bug#10）。
 *
 * 策略：
 *  1. 原图 ≤100KB 且格式为手表可解析的 PNG/JPEG → 直接给原图；
 *  2. 原图超限 → 退化为「不缩尺寸、只降质量」的重编码，仍超限才等比缩小；
 *  3. 任何情况下都不会返回 >100KB 的文件（否则手表必然下载失败）。
 */
export async function processWatchOriginal(message: MessageRow, index: number, att: AttachmentMeta): Promise<WatchImage> {
  return withInflight(`o:${message.id}:${index}`, async () => {
    ensureDirs();
    const base = watchBase(message.id, index);
    const metaPath = `${base}.orig.json`;
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
          path: string; contentType: string; width: number; height: number; size: number;
        };
        if (meta.path && fs.existsSync(meta.path) && meta.size <= 100 * 1024) {
          return {
            path: meta.path, contentType: meta.contentType,
            size: fs.statSync(meta.path).size, width: meta.width, height: meta.height,
          };
        }
      } catch {
        /* stale */
      }
    }

    const local = await ensureLocal(message, index, att);
    const ct = (local.contentType || "").toLowerCase();
    const maxBytes = 100 * 1024;

    // 步骤 1：原图本身就是手表可解析的格式且不超限 → 直接用原图
    if ((ct === "image/png" || ct === "image/jpeg" || ct === "image/jpg") && fs.statSync(local.path).size <= maxBytes) {
      const dims = await probeImage(local.path, att);
      fs.writeFileSync(metaPath, JSON.stringify({
        path: local.path, contentType: local.contentType, width: dims.width, height: dims.height, size: fs.statSync(local.path).size,
      }));
      return { path: local.path, contentType: local.contentType, size: fs.statSync(local.path).size, width: dims.width, height: dims.height };
    }

    // 步骤 2/3：重编码 —— 先保尺寸降质量，再逐级缩小
    const outPath = `${base}.orig.jpg`;
    const tmpBase = `${outPath}.tmp-${Date.now()}`;
    // 不缩尺寸（或最多缩到 480 长边，仍远高于屏幕 240）；质量逐级下降
    const plans: Array<{ size: number; q: number }> = [];
    for (const q of [3, 5, 7, 9, 12, 16, 20, 24, 28]) plans.push({ size: 480, q });
    for (const q of [8, 14, 20, 26]) plans.push({ size: 320, q });
    for (const q of [14, 22]) plans.push({ size: 240, q });

    try {
      for (const plan of plans) {
        const tmp = `${tmpBase}.jpg`;
        const scale = `scale='min(${plan.size},iw)':'min(${plan.size},ih)':force_original_aspect_ratio=decrease`;
        const args = ["-y", "-i", local.path, "-vf", scale, "-frames:v", "1", "-q:v", String(plan.q), "-f", "image2", tmp];
        try {
          await execFileAsync("ffmpeg", args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
          const bytes = fs.statSync(tmp).size;
          if (bytes <= maxBytes) {
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
            fs.renameSync(tmp, outPath);
            const dims = await probeImage(outPath, att);
            const actual = fs.statSync(outPath).size;
            fs.writeFileSync(metaPath, JSON.stringify({
              path: outPath, contentType: "image/jpeg", width: dims.width, height: dims.height, size: actual,
            }));
            return { path: outPath, contentType: "image/jpeg", size: actual, width: dims.width, height: dims.height };
          }
        } finally {
          try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
        }
      }
      throw appError("MEDIA_ERROR", "原图不可用", "原图过大，手表无法解析");
    } catch (e) {
      if (e instanceof AppError) throw e;
      log.warn("watch original image failed", e);
      throw appError("MEDIA_ERROR", "原图处理失败", "请稍后重试");
    }
  });
}

async function probeImage(filePath: string, att: AttachmentMeta): Promise<{ width: number; height: number }> {
  try {
    const probe = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", filePath,
    ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const [w, h] = probe.stdout.trim().split("x").map(Number);
    if (w > 0 && h > 0) return { width: w, height: h };
  } catch { /* fallthrough */ }
  return { width: Number(att.width) || 240, height: Number(att.height) || 240 };
}
