import { getSessionUserFromRequest } from "@/lib/auth";
import { db } from "@/db";
import { contacts, conversations, friendEvents, groupRobotEvents, joinRequests, messages, sessions, settings, users } from "@/db/schema";
import { eq, ne, sql, getTableColumns } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { listUsersWithSetting } from "@/server/repo";
import { deleteUserCascade } from "@/server/userDelete";
import { appError } from "@/lib/errors";
import { fail, ok, readJson } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 批量清除「未绑定 QQ 机器人」的用户。
 *
 * 高危操作，默认 **dry-run**（只统计、不删除），必须在请求体显式传
 * `{ "dryRun": false }` 才会真正删除。仅管理员可用。
 *
 * 判定标准：settings 表无 key="credentials" 行的用户即为「未绑定」；admin 账号
 * 永远被排除（既不会被统计也不会被删）。
 *
 * 返回：
 *  - dry-run：totalUsers / boundUsers / unboundUsers，以及每个待删用户的各行数明细；
 *  - 执行：上述计数 + deleted（实际删除的用户数）。
 */
export async function POST(req: Request) {
  try {
    const admin = await getSessionUserFromRequest(req);
    if (!admin || admin.username !== "admin") throw appError("AUTH_ERROR", "请先使用管理员账号登录", "");
    const { dryRun } = await readJson<{ dryRun?: boolean }>(req);
    const execute = dryRun === false; // 默认 dry-run

    const all = await db
      .select({ id: users.id, username: users.username, createdAt: users.createdAt })
      .from(users)
      .where(ne(users.username, "admin"));
    const bound = new Set(await listUsersWithSetting("credentials"));
    const unbound = all.filter((u) => !bound.has(u.id));

    if (!execute) {
      const detail = [];
      for (const u of unbound) {
        detail.push({
          id: u.id,
          username: u.username,
          createdAt: u.createdAt,
          rows: {
            messages: await countRows(messages, u.id),
            conversations: await countRows(conversations, u.id),
            sessions: await countRows(sessions, u.id),
            settings: await countRows(settings, u.id),
            contacts: await countRows(contacts, u.id),
            friendEvents: await countRows(friendEvents, u.id),
            groupRobotEvents: await countRows(groupRobotEvents, u.id),
            joinRequests: await countRows(joinRequests, u.id),
          },
        });
      }
      return ok({
        dryRun: true,
        totalUsers: all.length,
        boundUsers: all.length - unbound.length,
        unboundUsers: unbound.length,
        users: detail,
      });
    }

    let deleted = 0;
    for (const u of unbound) {
      await deleteUserCascade(u.id);
      deleted += 1;
    }
    return ok({
      dryRun: false,
      totalUsers: all.length,
      boundUsers: all.length - unbound.length,
      unboundUsers: unbound.length,
      deleted,
    });
  } catch (e) {
    return fail(e);
  }
}

async function countRows(table: AnyPgTable, userId: string): Promise<number> {
  const col = getTableColumns(table).userId;
  const r = await db.select({ c: sql<number>`count(*)` }).from(table).where(eq(col, userId));
  return Number(r[0]?.c ?? 0);
}
