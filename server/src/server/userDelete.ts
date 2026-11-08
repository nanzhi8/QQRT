import { db } from "@/db";
import {
  contacts,
  conversations,
  friendEvents,
  groupRobotEvents,
  joinRequests,
  messages,
  sessions,
  settings,
  users,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { listConversations, deleteConversation, listUsersWithSetting } from "@/server/repo";
import { removeInboundCache, removeOutboundMedia } from "@/server/media";
import type { AttachmentMeta } from "@/db/schema";

/**
 * 彻底删除一个用户及其全部数据（供管理员单删 与 批量清理未绑定用户复用）。
 *
 * 与 `admin/users/delete` 旧实现保持一致：先逐会话删除消息并清理对应媒体缓存
 * （出站本地文件、入站缩略图缓存），再清掉各业务表、最后删用户本身。
 * 本服务用 PGlite（进程内 Postgres，无外键约束），因此按 user_id 逐表删除。
 */
export async function deleteUserCascade(userId: string): Promise<void> {
  const convs = await listConversations(userId);
  for (const conv of convs) {
    const rows = await deleteConversation(userId, conv.id);
    for (const row of rows) {
      const atts = (row.attachments as AttachmentMeta[] | null) ?? [];
      if (row.direction === "out") {
        for (const att of atts) {
          if (att.localId) removeOutboundMedia(att.localId);
        }
      } else {
        for (let index = 0; index < atts.length; index += 1) {
          removeInboundCache(row.id, index);
        }
      }
    }
  }

  await db.delete(messages).where(eq(messages.userId, userId));
  await db.delete(conversations).where(eq(conversations.userId, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(settings).where(eq(settings.userId, userId));
  await db.delete(contacts).where(eq(contacts.userId, userId));
  await db.delete(friendEvents).where(eq(friendEvents.userId, userId));
  await db.delete(groupRobotEvents).where(eq(groupRobotEvents.userId, userId));
  await db.delete(joinRequests).where(eq(joinRequests.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

/**
 * 找出所有「未绑定 QQ 机器人」的普通用户（不含 admin）。
 * 判定标准：settings 表中没有 key="credentials" 的行。机器人断开连接时
 * botManager 会 delSetting 掉该键，因此「未绑定」= 无该键。
 */
export async function findUnboundUserIds(): Promise<string[]> {
  const rows = await db.select({ id: users.id, username: users.username }).from(users);
  const bound = new Set(await listUsersWithSetting("credentials"));
  return rows.filter((u) => u.username !== "admin" && !bound.has(u.id)).map((u) => u.id);
}
