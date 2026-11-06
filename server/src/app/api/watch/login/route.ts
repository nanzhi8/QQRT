import { createSession, loginUser } from "@/lib/auth";
import { authRateLimit } from "@/lib/rateLimit";
import { statusPayload } from "@/server/botManager";
import { fail, ok } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 手表登录：使用网站内部账号换取 session token。
 * POST JSON（system.fetch）与 GET 查询参数（下载通道兜底）均支持。
 */
async function handle(req: Request, username: string | undefined, password: string | undefined) {
  try {
    if (!username || !password) {
      return fail(new Error("请输入用户名和密码"), 400);
    }
    authRateLimit(req, username);
    const user = await loginUser(username, password);
    const session = await createSession(user.id, "watch-rtos");
    const bot = await statusPayload(user.id).catch(() => null);
    return ok({ token: session.token, userId: user.id, username: user.username, bot });
  } catch (e) {
    return fail(e, 401);
  }
}

export async function POST(req: Request) {
  let username: string | undefined;
  let password: string | undefined;
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("json")) {
    const body = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
    username = body.username;
    password = body.password;
  } else {
    const url = new URL(req.url);
    username = url.searchParams.get("username") ?? undefined;
    password = url.searchParams.get("password") ?? undefined;
  }
  return handle(req, username, password);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  return handle(req, url.searchParams.get("username") ?? undefined, url.searchParams.get("password") ?? undefined);
}
