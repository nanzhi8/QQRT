import fs from "node:fs";
import { Readable } from "node:stream";
import { appError } from "@/lib/errors";
import { fail, requireUser } from "@/server/httpUtil";
import { getMessage } from "@/server/repo";
import { watchVideoSegmentPath } from "@/server/watchMedia";
import type { MessageRow } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 提供单个视频分段文件（mp4）。fwd 开头为合并转发子视频的伪 ID。 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ messageId: string; index: string; seg: string }> },
) {
  try {
    const user = await requireUser(req);
    const { messageId, index, seg } = await params;
    const idx = Number(index);
    const segIdx = Number(seg);
    if (!Number.isInteger(idx) || idx < 0 || !Number.isInteger(segIdx) || segIdx < 0) {
      throw appError("INVALID_REQUEST", "无效的分段序号", "");
    }
    let message: MessageRow | null;
    if (/^fwd[0-9a-f]{16}$/.test(messageId)) {
      message = { id: messageId, userId: user.id } as MessageRow;
    } else {
      message = await getMessage(user.id, messageId);
    }
    if (!message) throw appError("INVALID_REQUEST", "消息不存在", "");
    const path = watchVideoSegmentPath(message, idx, segIdx);
    if (!path) throw appError("INVALID_REQUEST", "分段不存在", "");

    const body = Readable.toWeb(fs.createReadStream(path)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(fs.statSync(path).size),
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return fail(e, 404);
  }
}
