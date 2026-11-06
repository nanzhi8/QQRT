import fs from "node:fs";
import { Readable } from "node:stream";
import { appError } from "@/lib/errors";
import { getCached, sanitizeName } from "@/server/media";
import { fail, requireUser } from "@/server/httpUtil";
import { getMessage } from "@/server/repo";
import { processWatchAudio, processWatchImage, watchMediaKind } from "@/server/watchMedia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 手表媒体：图片等比缩放到 240x240 内，语音统一转 MP3，文件直接透传。
 * 结果按 messageId-index 缓存，重复请求直接命中。
 */
export async function GET(req: Request, { params }: { params: Promise<{ messageId: string; index: string }> }) {
  try {
    const user = await requireUser(req);
    const { messageId, index } = await params;
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0) throw appError("INVALID_REQUEST", "无效的附件序号", "");

    const message = await getMessage(user.id, messageId);
    if (!message) throw appError("INVALID_REQUEST", "消息不存在", "");
    const att = message.attachments[idx];
    if (!att) throw appError("INVALID_REQUEST", "附件不存在", "");

    const kind = watchMediaKind(att);
    let filePath: string;
    let contentType: string;

    if (kind === "image") {
      const img = await processWatchImage(message, idx, att);
      filePath = img.path;
      contentType = img.contentType;
    } else if (kind === "audio") {
      const audio = await processWatchAudio(message, idx, att);
      filePath = audio.path;
      contentType = audio.contentType;
    } else {
      // 文件：透传 QQ 缓存原文件。
      let cached = getCached(message.id, idx);
      if (!cached) {
        if (att.localId) {
          // 出站媒体：附件只保存了本地上传文件的 localId，直接从 outDir 读取。
          const { outPathFor } = await import("@/server/media");
          const p = outPathFor(att.localId);
          if (p) cached = { path: p, contentType: att.contentType || "application/octet-stream", size: fs.statSync(p).size };
        }
      }
      if (!cached) {
        if (!att.url) throw appError("INVALID_REQUEST", "该附件没有下载地址", "");
        let getToken: (() => Promise<string>) | undefined;
        try {
          const { requireBot } = await import("@/server/botManager");
          getToken = () => requireBot(user.id).api.getToken();
        } catch {
          /* 匿名下载 */
        }
        const { cacheInbound } = await import("@/server/media");
        cached = await cacheInbound(message.id, idx, att.url, att.contentType, getToken);
      }
      filePath = cached.path;
      contentType = cached.contentType;
    }

    const body = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>;
    const filename = sanitizeName(att.filename || `file-${idx + 1}`);
    const disposition = kind === "file" ? "attachment" : "inline";
    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fs.statSync(filePath).size),
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return fail(e, 404);
  }
}
