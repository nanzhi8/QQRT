import fs from "node:fs";
import { Readable } from "node:stream";
import { appError } from "@/lib/errors";
import { fail, requireUser } from "@/server/httpUtil";
import { getMessage } from "@/server/repo";
import { processWatchOriginal } from "@/server/watchMedia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 手表「查看原图」（bug#10）。
 *
 * 与 /api/watch/media 的区别：这里**不按屏幕尺寸缩放**，尽量给最清晰的版本；
 * 但仍严格遵守官方硬限制 —— 单图必须 ≤100KB，否则手表必然下载失败。
 * 因此超限时会「保尺寸降质量」，仍超限才逐级缩小，绝不返回 >100KB 的文件。
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

    const img = await processWatchOriginal(message, idx, att);
    const body = Readable.toWeb(fs.createReadStream(img.path)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "Content-Type": img.contentType,
        "Content-Length": String(fs.statSync(img.path).size),
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
        "X-Watch-Image-Width": String(img.width),
        "X-Watch-Image-Height": String(img.height),
      },
    });
  } catch (e) {
    return fail(e, 404);
  }
}
