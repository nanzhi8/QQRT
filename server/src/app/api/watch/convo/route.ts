import { renameConversation } from "@/server/botManager";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { removeInboundCache, removeOutboundMedia } from "@/server/media";
import type { MessageRow } from "@/db/schema";
import {
  deleteConversation,
  deleteConversationMessages,
  getConversation,
  resetConversationsAfterClear,
} from "@/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cleanupCaches(rows: MessageRow[]): void {
  for (const row of rows) {
    if (row.direction === "out") {
      for (const att of row.attachments as Array<{ localId?: string }>) {
        if (att.localId) removeOutboundMedia(att.localId);
      }
    } else {
      for (let index = 0; index < (row.attachments as unknown[]).length; index += 1) {
        removeInboundCache(row.id, index);
      }
    }
  }
}

/** 手表会话管理：查看 / 改备注 / 清空记录 / 删除会话。 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const conversationId = url.searchParams.get("conversationId") || "";
    if (!conversationId) return fail(new Error("缺少会话 ID"), 400);
    const conv = await getConversation(user.id, conversationId);
    if (!conv) return fail(new Error("会话不存在"), 404);
    return ok({
      conversation: {
        id: conv.id,
        scope: conv.scope,
        peerId: conv.peerId,
        title: conv.remark || conv.title,
        remark: conv.remark,
        unread: conv.unread,
        lastPreview: conv.lastPreview,
        lastMessageAt: conv.lastMessageAt,
      },
    });
  } catch (e) {
    // 兜底状态码不能是 401：手表把 401 视为登录失效会直接踢回登录页，
    // 数据库抖动等瞬时错误会因此误判为掉登录。真正的 AUTH_ERROR 由 fail() 内部映射为 401。
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { conversationId?: string; action?: string; remark?: string };
    const conversationId = body.conversationId || "";
    const action = body.action || "";
    if (!conversationId) return fail(new Error("缺少会话 ID"), 400);

    if (action === "remark") {
      const updated = await renameConversation(user.id, conversationId, body.remark ?? "");
      return ok({ conversation: updated });
    }
    if (action === "clear") {
      const rows = await deleteConversationMessages(user.id, conversationId);
      cleanupCaches(rows);
      await resetConversationsAfterClear(user.id, conversationId);
      return ok({ deleted: rows.length });
    }
    if (action === "delete") {
      const rows = await deleteConversation(user.id, conversationId);
      cleanupCaches(rows);
      return ok({ deleted: rows.length });
    }
    return fail(new Error("未知操作"), 400);
  } catch (e) {
    return fail(e);
  }
}
