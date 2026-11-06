import { createHash } from "node:crypto";
import { assertSafeUrl } from "@/lib/ssrf";
import { appError } from "@/lib/errors";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { processWatchOriginal } from "@/server/watchMedia";
import type { AttachmentMeta, MessageRow } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url).searchParams.get("url") || "";
    if (!url || !/^https?:\/\//i.test(url)) throw appError("INVALID_REQUEST", "媒体地址无效", "");
    assertSafeUrl(url);
    const hash = createHash("sha1").update(`${user.id}:${url}`).digest("hex").slice(0, 16);
    const message = { id: `fwd${hash}`, userId: user.id } as MessageRow;
    const att: AttachmentMeta = { url, contentType: "image/jpeg" };
    const img = await processWatchOriginal(message, 0, att);
    return ok({
      width: img.width,
      height: img.height,
      contentType: img.contentType,
      size: img.size,
      sourceWidth: img.width,
      sourceHeight: img.height,
    });
  } catch (e) {
    return fail(e, 404);
  }
}
