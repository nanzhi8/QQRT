import { ensureSchema } from "@/db/bootstrap";
import { hashPassword } from "@/lib/auth";
import { getSessionUserFromRequest } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { appError } from "@/lib/errors";
import { fail, ok, readJson } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 管理员重置任意账号的密码（不需要知道旧密码） */
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const admin = await getSessionUserFromRequest(req);
    if (!admin || admin.username !== "admin") throw appError("AUTH_ERROR", "请先使用管理员账号登录", "请重新登录");
    const { username, newPassword } = await readJson<{ username?: string; newPassword?: string }>(req);
    if (!username || !newPassword) return fail(new Error("请输入账号和新密码"), 400);
    if (String(newPassword).length < 6 || String(newPassword).length > 64) {
      return fail(new Error("新密码长度需为 6-64 位"), 400);
    }
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.username, String(username).trim())).limit(1);
    if (!rows.length) throw appError("INVALID_REQUEST", "账号不存在", "");
    await db
      .update(users)
      .set({ passwordHash: hashPassword(String(newPassword)) })
      .where(eq(users.id, rows[0].id));
    return ok({ changed: true, username: String(username).trim() });
  } catch (e) {
    return fail(e);
  }
}
