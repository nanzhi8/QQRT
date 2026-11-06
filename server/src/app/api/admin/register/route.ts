import { getSessionUserFromRequest, registerUser } from "@/lib/auth";
import { appError } from "@/lib/errors";
import { fail, ok, readJson } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const admin = await getSessionUserFromRequest(req);
    if (!admin || admin.username !== "admin") throw appError("AUTH_ERROR", "请先使用管理员账号登录", "请重新登录");
    const { username, password } = await readJson<{ username?: string; password?: string }>(req);
    if (!username || !password) return fail(new Error("请输入新用户账号和密码"), 400);
    const user = await registerUser(username, password);
    return ok({ user: { id: user.id, username: user.username } });
  } catch (e) {
    return fail(e);
  }
}
