import { getSessionUserFromRequest } from "@/lib/auth";
import { db } from "@/db";
import { contacts, conversations, friendEvents, groupRobotEvents, joinRequests, messages, sessions, settings, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { listConversations, deleteConversation } from "@/server/repo";
import { removeInboundCache, removeOutboundMedia } from "@/server/media";
import { appError } from "@/lib/errors";
import { fail, ok, readJson } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const admin = await getSessionUserFromRequest(req);
    if (!admin || admin.username !== "admin") throw appError("AUTH_ERROR", "请先使用管理员账号登录", "");
    const { id } = await readJson<{ id?: string }>(req);
    if (!id) return fail(new Error("缺少用户 ID"), 400);

    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target) return fail(new Error("用户不存在"), 404);
    if (target.username === "admin") return fail(new Error("不能删除管理员"), 400);

    const convs = await listConversations(target.id);
    for (const conv of convs) {
      const rows = await deleteConversation(target.id, conv.id);
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

    await db.delete(messages).where(eq(messages.userId, target.id));
    await db.delete(conversations).where(eq(conversations.userId, target.id));
    await db.delete(sessions).where(eq(sessions.userId, target.id));
    await db.delete(settings).where(eq(settings.userId, target.id));
    await db.delete(contacts).where(eq(contacts.userId, target.id));
    await db.delete(friendEvents).where(eq(friendEvents.userId, target.id));
    await db.delete(groupRobotEvents).where(eq(groupRobotEvents.userId, target.id));
    await db.delete(joinRequests).where(eq(joinRequests.userId, target.id));
    await db.delete(users).where(eq(users.id, target.id));
    return ok({ deleted: target.id });
  } catch (e) {
    return fail(e);
  }
}
