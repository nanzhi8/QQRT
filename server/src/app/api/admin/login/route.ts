import { buildSessionCookie, createSession, loginUser } from "@/lib/auth";
import { fail, ok, readJson } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { username, password } = await readJson<{ username?: string; password?: string }>(req);
    if (!username || !password) return fail(new Error("请输入管理员账号和密码"), 400);
    const admin = await loginUser(username, password);
    if (admin.username !== "admin") return fail(new Error("不是管理员账号"), 403);
    const { token, maxAge } = await createSession(admin.id, req.headers.get("user-agent"));
    return ok(
      { user: { id: admin.id, username: admin.username }, token, maxAge },
      { headers: { "Set-Cookie": buildSessionCookie(req, token, maxAge) } },
    );
  } catch (e) {
    return fail(e, 401);
  }
}
