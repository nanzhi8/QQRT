import { appError } from "@/lib/errors";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { getMessage } from "@/server/repo";
import { processWatchOriginal } from "@/server/watchMedia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 手表「查看原图」前的探测接口（bug#10）。
 *
 * 返回原图最终会以多大尺寸、什么格式、多少字节交付给手表。
 * 由于服务器必须遵守「单图 ≤100KB」的官方硬限制，这里返回的尺寸是
 * **实际能交付的尺寸**，而不是 QQ 原图的标称尺寸 —— 手表据此调整渲染大小，
 * 不会出现「以为拿到 1920×1080，实际只有 480×270」的错位。
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
    return ok({
      width: img.width,
      height: img.height,
      contentType: img.contentType,
      size: img.size,
      // QQ 侧标称的原始尺寸，供界面提示「原图 1920×1080」用。
      sourceWidth: att.width ?? img.width,
      sourceHeight: att.height ?? img.height,
    });
  } catch (e) {
    return fail(e, 404);
  }
}
