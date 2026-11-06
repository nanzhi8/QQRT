import { appError } from "@/lib/errors";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { getMessage } from "@/server/repo";
import { processWatchImage, watchMediaKind } from "@/server/watchMedia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 手表媒体元信息（图片尺寸等），供 media 页按正确比例渲染。
 * 图片会顺带触发一次转码（幂等缓存）。
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
    /* 顺带返回本条消息里**所有图片附件的下标**（imgIdx）。
     * media 查看页据此提供「上一张 / 下一张」导航：一条消息里有多张图时，
     * 由服务端告知图片附件的下标清单，无需依赖页面路由参数传递
     * （页面实例可能被复用，路由参数并不总能送达）。 */
    const imgIdx: number[] = [];
    for (let i = 0; i < (message.attachments?.length ?? 0); i++) {
      const a2 = message.attachments[i];
      if (a2 && watchMediaKind(a2) === "image") imgIdx.push(i);
    }
    if (kind === "image") {
      const img = await processWatchImage(message, idx, att);
      return ok({
        kind,
        width: img.width,
        height: img.height,
        contentType: img.contentType,
        size: img.size,
        filename: att.filename ?? null,
        imgIdx,
        // #10 供手表判断「是否有更清晰的原图可看」：原始尺寸来自 QQ 附件元数据。
        origWidth: att.width ?? img.width,
        origHeight: att.height ?? img.height,
      });
    }
    return ok({
      kind,
      width: att.width ?? 240,
      height: att.height ?? 240,
      contentType: att.contentType,
      size: att.size ?? 0,
      filename: att.filename ?? null,
      asrText: att.asrText ?? null,
      duration: att.duration ?? null,
      imgIdx,
    });
  } catch (e) {
    return fail(e, 404);
  }
}
