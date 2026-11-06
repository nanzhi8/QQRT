import { buildSessionCookie, createSession, registerUser } from "@/lib/auth";
import { ensureSchema } from "@/db/bootstrap";
import { appError } from "@/lib/errors";
import { authRateLimit } from "@/lib/rateLimit";
import { fail, ok, readJson } from "@/server/httpUtil";
import { isSignupEnabled } from "@/server/signup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 非管理员自助注册：注册后直接登录，可在控制台绑定自己的机器人 */
export async function POST(req: Request) {
  try {
    await ensureSchema();
    if (!(await isSignupEnabled())) {
      throw appError("INVALID_REQUEST", "管理员已关闭自助注册", "请联系管理员在控制台开通");
    }
    const { username, password } = await readJson<{ username?: string; password?: string }>(req);
    if (!username || !password) return fail(new Error("请输入用户名和密码"), 400);
    authRateLimit(req, `signup:${username.trim()}`);
    if (username.trim() === "admin") throw appError("INVALID_REQUEST", "该用户名不可用", "");
    const user = await registerUser(username, password);
    const { token, maxAge } = await createSession(user.id, req.headers.get("user-agent"));
    return ok(
      { user: { id: user.id, username: user.username }, token, maxAge },
      { headers: { "Set-Cookie": buildSessionCookie(req, token, maxAge) } },
    );
  } catch (e) {
    return fail(e);
  }
}

/** 查询自助注册是否开放（供登录页决定是否显示注册入口） */
export async function GET() {
  try {
    await ensureSchema();
    return ok({ enabled: await isSignupEnabled() });
  } catch (e) {
    return fail(e);
  }
}
