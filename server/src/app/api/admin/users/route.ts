import { ensureSchema } from "@/db/bootstrap";
import { getSessionUserFromRequest } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { asc, ne } from "drizzle-orm";
import { fail, ok } from "@/server/httpUtil";
import { statusPayload } from "@/server/botManager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 用户列表（仅管理员）。
 * 附带每个账号的机器人绑定情况：hasBot / connected / botName / appId / lastSyncAt。
 * 只返回掩码后的 AppID，绝不返回 AppSecret。
 */
export async function GET(req: Request) {
  try {
    await ensureSchema();
    const admin = await getSessionUserFromRequest(req);
    if (!admin || admin.username !== "admin") return fail(new Error("请先使用管理员账号登录"), 401);
    const rows = await db
      .select({ id: users.id, username: users.username, createdAt: users.createdAt })
      .from(users)
      .where(ne(users.username, "admin"))
      .orderBy(asc(users.createdAt));

    const list = [];
    for (const row of rows) {
      let bound = {
        hasBot: false,
        connected: false,
        botName: null as string | null,
        appId: null as string | null,
        lastSyncAt: null as number | null,
      };
      try {
        const st = await statusPayload(row.id);
        bound = {
          hasBot: st.hasCredentials,
          connected: st.connected,
          botName: st.bot?.username ?? null,
          appId: st.appId ?? null,
          lastSyncAt: st.lastSyncAt,
        };
      } catch {
        /* 单个账号状态读取失败不影响列表 */
      }
      list.push({ ...row, ...bound });
    }
    return ok({ users: list });
  } catch (e) {
    return fail(e);
  }
}
