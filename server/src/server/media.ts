import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import { config, ensureDirs } from "@/lib/config";
import { appError } from "@/lib/errors";
import { log } from "@/lib/logger";

/**
 * 媒体管道：
 * - 浏览器上传：busboy 流式落盘，大文件不占内存；
 * - QQ 接收的附件：通过 /api/media/in 代理 + 磁盘缓存，浏览器不直连 QQ CDN。
 */

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "audio/silk": ".silk",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/plain": ".txt",
};

export function sanitizeName(name: string): string {
  const base = path.basename(String(name || "file")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const clean = base || "file";
  return clean.length > 150 ? clean.slice(-150) : clean;
}

export function extForMime(mime: string): string {
  return MIME_EXT[mime] || ".bin";
}

export interface SavedUpload {
  localId: string;
  localPath: string;
  fileName: string;
  contentType: string;
  size: number;
  kind: string;
}

export function saveUpload(req: Request): Promise<SavedUpload> {
  return new Promise<SavedUpload>((resolve, reject) => {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      reject(appError("INVALID_REQUEST", "请求不是 multipart 上传", "请使用表单上传文件"));
      return;
    }
    if (!req.body) {
      reject(appError("INVALID_REQUEST", "上传内容为空", "请选择文件"));
      return;
    }
    ensureDirs();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const bb = Busboy({
      headers,
      limits: { fileSize: config.maxUploadBytes, files: 1 },
      defParamCharset: "utf8",
    });

    const localId = randomUUID();
    let kind = "file";
    let result: SavedUpload | null = null;
    let failure: Error | null = null;
    let finalPath: string | null = null;
    let fileDone = false;
    let bbDone = false;
    let truncated = false;

    const maybeFinish = () => {
      if (!fileDone || !bbDone) return;
      if (failure || truncated) {
        if (finalPath) {
          try {
            fs.unlinkSync(finalPath);
          } catch {
            /* ignore */
          }
        }
        reject(
          truncated
            ? appError("INVALID_REQUEST", `文件超过 ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB 上限`, "请压缩后重试或调大 MAX_UPLOAD_MB")
            : failure ?? appError("INVALID_REQUEST", "上传失败", "请重试"),
        );
        return;
      }
      if (result) resolve(result);
      else reject(appError("INVALID_REQUEST", "未收到文件内容", "请选择文件"));
    };

    bb.on("field", (name, value) => {
      if (name === "kind") kind = String(value || "file");
    });

    bb.on("file", (_name, fileStream, info) => {
      const safeName = sanitizeName(info.filename);
      const mime = info.mimeType || "application/octet-stream";
      const ext = path.extname(safeName) || extForMime(mime);
      finalPath = path.join(config.outDir, `${localId}${ext}`);
      const ws = fs.createWriteStream(finalPath, { flags: "wx" });
      let size = 0;
      fileStream.on("data", (chunk: Buffer) => {
        size += chunk.length;
      });
      fileStream.on("limit", () => {
        truncated = true;
      });
      pipeline(fileStream, ws)
        .then(() => {
          fileDone = true;
          if (!truncated) {
            result = { localId, localPath: finalPath!, fileName: safeName, contentType: mime, size, kind };
          }
          maybeFinish();
        })
        .catch((e) => {
          failure = e instanceof Error ? e : new Error(String(e));
          fileDone = true;
          maybeFinish();
        });
    });

    bb.on("finish", () => {
      bbDone = true;
      maybeFinish();
    });
    bb.on("error", (e) => {
      failure = e instanceof Error ? e : new Error(String(e));
      bbDone = true;
      maybeFinish();
    });

    void pipeline(
      // @ts-expect-error Web ReadableStream → Node Readable 兼容（Next 请求体）
      req.body,
      bb,
    ).catch((e) => {
      if (!result && !failure) {
        failure = e instanceof Error ? e : new Error(String(e));
        bbDone = true;
        fileDone = true;
        maybeFinish();
      }
    });
  });
}

export function outPathFor(localId: string): string | null {
  const safe = path.basename(localId);
  if (!/^[0-9a-f-]{8,64}/.test(safe.replace(path.extname(safe), ""))) return null;
  try {
    const entries = fs.readdirSync(config.outDir);
    const hit = entries.find((f) => f.startsWith(safe.replace(/\.[^.]+$/, "")));
    return hit ? path.join(config.outDir, hit) : null;
  } catch {
    return null;
  }
}

/** 删除本地出站媒体文件（用于清空聊天缓存）。 */
export function removeOutboundMedia(localId: string): void {
  try {
    const p = outPathFor(localId);
    if (p) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

// ── 接收附件代理缓存 ──────────────────────────────────────────────────────

const MAX_CACHE_BYTES = 300 * 1024 * 1024;

function cachePathFor(messageId: string, index: number): string {
  const safeMsg = messageId.replace(/[^0-9a-zA-Z-]/g, "");
  return path.join(config.inDir, `${safeMsg}-${index}`);
}

export interface CachedMedia {
  path: string;
  contentType: string;
  size: number;
}

export function getCached(messageId: string, index: number): CachedMedia | null {
  const p = cachePathFor(messageId, index);
  const metaPath = `${p}.meta.json`;
  try {
    if (!fs.existsSync(p) || !fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { contentType?: string };
    const size = fs.statSync(p).size;
    return { path: p, contentType: meta.contentType || "application/octet-stream", size };
  } catch {
    return null;
  }
}

/** 删除接收附件在服务器上的缓存文件。 */
export function removeInboundCache(messageId: string, index: number): void {
  const p = cachePathFor(messageId, index);
  const metaPath = `${p}.meta.json`;
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  } catch {
    /* ignore */
  }
}

/** 从 QQ CDN 拉取附件并缓存。getToken 返回当前 access_token（需要时加鉴权头）。 */
export async function cacheInbound(messageId: string, index: number, url: string, contentType: string, getToken?: () => Promise<string>): Promise<CachedMedia> {
  ensureDirs();
  const cached = getCached(messageId, index);
  if (cached) return cached;

  const tmp = `${cachePathFor(messageId, index)}.tmp-${randomUUID()}`;
  const doFetch = async (token?: string) => {
    const headers: Record<string, string> = { "User-Agent": "qqbot-web-client/1.0" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`下载失败: HTTP ${res.status}`);
    return res;
  };

  let res: Response;
  try {
    res = await doFetch();
    if ((res.status === 401 || res.status === 403) && getToken) {
      res = await doFetch(await getToken());
    }
  } catch (e) {
    if (getToken) {
      try {
        res = await doFetch(await getToken());
      } catch {
        throw e;
      }
    } else {
      throw e;
    }
  }

  try {
    const ws = fs.createWriteStream(tmp);
    let written = 0;
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        written += value.byteLength;
        if (written > MAX_CACHE_BYTES) throw new Error("文件过大，超过缓存上限");
        if (!ws.write(value)) await new Promise<void>((r) => ws.once("drain", () => r()));
      }
    }
    ws.end();
    await new Promise<void>((r, rej) => {
      ws.on("finish", () => r());
      ws.on("error", rej);
    });
    const finalPath = cachePathFor(messageId, index);
    fs.renameSync(tmp, finalPath);
    let ct = res.headers.get("content-type") || contentType || "application/octet-stream";
    // QQ CDN 对部分文件会返回 JSON/文本包装，避免把真实文件缓存成 JSON。
    const normalized = ct.split(";")[0].trim().toLowerCase();
    if (normalized === "application/json" || normalized === "text/plain") {
      const prefer = contentType.split(";")[0].trim().toLowerCase();
      if (prefer && prefer !== "application/json" && prefer !== "text/plain") ct = contentType;
      else ct = "application/octet-stream";
    }
    // bug#10：QQ 语音的真实编码是 SILK，但 CDN 会把响应头谎报为 audio/mp3。
    // 这里统一把「voice」以及被谎报的 mp3 归一成 audio/voice，避免下游
    // 误以为缓存里就是 MP3 而直接透传给手表。真实格式交由转码/魔数嗅探判定。
    if (normalized === "audio/mp3" || normalized === "audio/mpeg") {
      const prefer = contentType.split(";")[0].trim().toLowerCase();
      ct = prefer === "voice" ? "audio/voice" : ct;
    } else if (normalized === "voice") {
      ct = "audio/voice";
    }
    fs.writeFileSync(`${finalPath}.meta.json`, JSON.stringify({ contentType: ct }));
    log.debug(`cached inbound media ${messageId}/${index} (${written} bytes)`);
    return { path: finalPath, contentType: ct, size: written };
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}
