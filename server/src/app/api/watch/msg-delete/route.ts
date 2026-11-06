import { fail, ok, requireUser } from "@/server/httpUtil";
import { removeInboundCache, removeOutboundMedia } from "@/server/media";
import { deleteMessageById, refreshConversationPreview } from "@/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手表删除单条本地消息（含对应媒体缓存）。 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { messageId?: string };
    const messageId = body.messageId || "";
    if (!messageId) return fail(new Error("缺少消息 ID"), 400);
    const row = await deleteMessageById(user.id, messageId);
    if (!row) return fail(new Error("消息不存在"), 404);
    if (row.direction === "out") {
      for (const att of row.attachments as Array<{ localId?: string }>) {
        if (att.localId) removeOutboundMedia(att.localId);
      }
    } else {
      for (let index = 0; index < (row.attachments as unknown[]).length; index += 1) {
        removeInboundCache(row.id, index);
      }
    }
    await refreshConversationPreview(user.id, row.conversationId).catch(() => {});
    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
