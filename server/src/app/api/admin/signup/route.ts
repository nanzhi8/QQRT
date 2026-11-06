import { ensureSchema } from "@/db/bootstrap";
import { getSessionUserFromRequest } from "@/lib/auth";
import { appError } from "@/lib/errors";
import { fail, ok, readJson } from "@/server/httpUtil";
import { isSignupEnabled, setSignupEnabled } from "@/server/signup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin(req: Request) {
  const admin = await getSessionUserFromRequest(req);
  if (!admin || admin.username !== "admin") throw appError("AUTH_ERROR", "请先使用管理员账号登录", "请重新登录");
  return admin;
}

export async function GET(req: Request) {
  try {
    await ensureSchema();
    await requireAdmin(req);
    return ok({ enabled: await isSignupEnabled() });
  } catch (e) {
    return fail(e);
  }
}

/** 打开/关闭「非管理员自助注册」 */
export async function POST(req: Request) {
  try {
    await ensureSchema();
    await requireAdmin(req);
    const { enabled } = await readJson<{ enabled?: boolean }>(req);
    await setSignupEnabled(enabled !== false);
    return ok({ enabled: enabled !== false });
  } catch (e) {
    return fail(e);
  }
}
