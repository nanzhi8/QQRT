import { recallMessage } from "@/server/botManager";
import { recallGroupMessage } from "@/server/qqGroup";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { fail, ok, requireUser } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 撤回消息。
 * - 自己发的 / 机器人发的：走原有 recallMessage
 * - 群聊里别人的消息：走群接口 DELETE /v2/groups/{g}/messages/{id}
 *   （需机器人是群管理员，且只能撤 2 分钟内的）
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { messageId?: string };
    const messageId = body.messageId || "";
    if (!messageId) return fail(new Error("缺少消息 ID"), 400);

    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.userId, user.id), eq(messages.id, messageId)))
      .limit(1);
    const row = rows[0];

    if (row && row.scope === "group" && row.direction === "in" && row.qqMessageId) {
      await recallGroupMessage(user.id, row.peerId, row.qqMessageId);
      await db.update(messages).set({ status: "recalled" }).where(eq(messages.id, messageId));
      return ok({ ok: true, scope: "group" });
    }

    await recallMessage(user.id, messageId);
    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
