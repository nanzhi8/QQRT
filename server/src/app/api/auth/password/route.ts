import { hashPassword, verifyPassword } from "@/lib/auth";
import { ensureSchema } from "@/db/bootstrap";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { appError } from "@/lib/errors";
import { fail, ok, readJson, requireUser } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 已登录用户修改自己的密码（需验证旧密码） */
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const user = await requireUser(req);
    const { oldPassword, newPassword } = await readJson<{ oldPassword?: string; newPassword?: string }>(req);
    if (!oldPassword || !newPassword) return fail(new Error("请输入旧密码和新密码"), 400);
    if (String(newPassword).length < 6 || String(newPassword).length > 64) {
      return fail(new Error("新密码长度需为 6-64 位"), 400);
    }
    const rows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    const row = rows[0];
    if (!row || !verifyPassword(String(oldPassword), row.passwordHash)) {
      throw appError("AUTH_ERROR", "旧密码不正确", "请重新输入");
    }
    await db.update(users).set({ passwordHash: hashPassword(String(newPassword)) }).where(eq(users.id, user.id));
    return ok({ changed: true });
  } catch (e) {
    return fail(e);
  }
}
