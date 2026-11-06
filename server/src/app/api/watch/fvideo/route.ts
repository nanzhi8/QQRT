import { createHash } from "node:crypto";
import { appError } from "@/lib/errors";
import { assertSafeUrl } from "@/lib/ssrf";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { processWatchVideo } from "@/server/watchMedia";
import type { AttachmentMeta, MessageRow } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

/** 合并转发子消息视频：转码 + ≤58 秒分段，返回分段清单。 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { url?: string };
    const url = new URL(req.url);
    const mediaUrl = body.url || url.searchParams.get("url") || "";
    if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) throw appError("INVALID_REQUEST", "媒体地址无效", "");
    assertSafeUrl(mediaUrl);
    const hash = createHash("sha1").update(mediaUrl).digest("hex").slice(0, 16);
    const message = { id: `fwd${hash}`, userId: user.id } as MessageRow;
    const att: AttachmentMeta = { url: mediaUrl, contentType: "video/mp4" };
    const video = await processWatchVideo(message, 0, att);
    return ok({ video });
  } catch (e) {
    return fail(e, 404);
  }
}

export async function GET(req: Request) {
  return POST(req);
}
