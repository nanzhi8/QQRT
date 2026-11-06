import fs from "node:fs";
import { Readable } from "node:stream";
import { appError } from "@/lib/errors";
import { fail } from "@/server/httpUtil";
import { outPathFor, sanitizeName } from "@/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 公开媒体（无需登录）：供 QQ 服务器拉取图文消息里的图片。
 * localId 为随机 UUID，不可猜解，泄露风险极低。
 */
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const p = outPathFor(id);
    if (!p) throw appError("INVALID_REQUEST", "文件不存在", "");
    const lower = p.toLowerCase();
    const ext = Object.keys(MIME_BY_EXT).find((e) => lower.endsWith(e)) ?? "";
    const body = Readable.toWeb(fs.createReadStream(p)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream",
        "Content-Length": String(fs.statSync(p).size),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(sanitizeName(`img${ext || ".jpg"}`))}`,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (e) {
    return fail(e, 404);
  }
}
