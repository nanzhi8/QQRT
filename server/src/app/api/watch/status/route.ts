import { statusPayload } from "@/server/botManager";
import { fail, ok, requireUser } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手表首页顶部状态：账号 + 机器人连接状态。 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const bot = await statusPayload(user.id).catch(() => null);
    return ok({ username: user.username, userId: user.id, bot });
  } catch (e) {
    // 兜底状态码不能是 401：手表把 401 视为登录失效会直接踢回登录页，
    // 数据库抖动等瞬时错误会因此误判为掉登录。真正的 AUTH_ERROR 由 fail() 内部映射为 401。
    return fail(e);
  }
}
