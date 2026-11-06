import { getSessionUserFromRequest } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { asc, ne } from "drizzle-orm";
import { fail, ok } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const admin = await getSessionUserFromRequest(req);
    if (!admin || admin.username !== "admin") return fail(new Error("请先使用管理员账号登录"), 401);
    const rows = await db
      .select({ id: users.id, username: users.username, createdAt: users.createdAt })
      .from(users)
      .where(ne(users.username, "admin"))
      .orderBy(asc(users.createdAt));
    return ok({ users: rows });
  } catch (e) {
    return fail(e);
  }
}
