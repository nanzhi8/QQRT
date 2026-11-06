import { buildSessionCookie, createSession, registerUser } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { appError } from "@/lib/errors";
import { fail, ok, readJson } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, "admin")).limit(1);
    if (existing.length > 0) throw appError("INVALID_REQUEST", "管理员已初始化", "");
    const { password } = await readJson<{ password?: string }>(req);
    if (!password) return fail(new Error("请输入管理员密码"), 400);
    const admin = await registerUser("admin", password);
    const { token, maxAge } = await createSession(admin.id, req.headers.get("user-agent"));
    return ok(
      { user: { id: admin.id, username: admin.username }, token, maxAge },
      { headers: { "Set-Cookie": buildSessionCookie(req, token, maxAge) } },
    );
  } catch (e) {
    return fail(e);
  }
}
