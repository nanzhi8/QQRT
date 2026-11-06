import { appError } from "@/lib/errors";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { getMessage } from "@/server/repo";
import { processWatchVideo, watchMediaKind } from "@/server/watchMedia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

/**
 * 手表视频：转成 H.264 baseline MP4、等比缩放到 240x240 内，并切成 ≤58 秒的
 * 多段。这里返回分段清单 JSON，手表按顺序下载并逐段播放。
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
    if (watchMediaKind(att) !== "video") throw appError("INVALID_REQUEST", "该附件不是视频", "");

    const video = await processWatchVideo(message, idx, att);
    return ok({ video });
  } catch (e) {
    return fail(e, 404);
  }
}
