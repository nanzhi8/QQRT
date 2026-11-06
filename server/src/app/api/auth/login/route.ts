import { buildSessionCookie, createSession, loginUser } from "@/lib/auth";
import { authRateLimit } from "@/lib/rateLimit";
import { fail, ok, readJson } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { username, password } = await readJson<{ username?: string; password?: string }>(req);
    if (!username || !password) {
      return fail(new Error("请输入用户名和密码"), 400);
    }
    authRateLimit(req, username);
    const user = await loginUser(username, password);
    const { token, maxAge } = await createSession(user.id, req.headers.get("user-agent"));
    return ok(
      { user: { id: user.id, username: user.username }, token, maxAge },
      { headers: { "Set-Cookie": buildSessionCookie(req, token, maxAge) } },
    );
  } catch (e) {
    return fail(e, 401);
  }
}
