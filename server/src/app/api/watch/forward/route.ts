import { appError } from "@/lib/errors";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { getMessage } from "@/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手表合并转发消息展开：返回卡片子消息数组。 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const messageId = url.searchParams.get("messageId") || "";
    if (!messageId) throw appError("INVALID_REQUEST", "缺少消息 ID", "");
    const message = await getMessage(user.id, messageId);
    if (!message) throw appError("INVALID_REQUEST", "消息不存在", "");
    if (message.msgType !== "forward") throw appError("INVALID_REQUEST", "该消息不是合并转发", "");
    let card: { title?: string; items?: unknown[]; unparsed?: boolean } = {};
    try {
      card = JSON.parse(message.text || "{}") as { title?: string; items?: unknown[]; unparsed?: boolean };
    } catch {
      card = {};
    }
    const items = Array.isArray(card.items) ? card.items : [];
    return ok({
      title: card.title || "[聊天记录]",
      items,
      unparsed: !!card.unparsed || items.length === 0,
    });
  } catch (e) {
    return fail(e, 404);
  }
}
