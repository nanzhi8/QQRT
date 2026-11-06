import { fail, ok, requireUser } from "@/server/httpUtil";
import { listWatchConversations } from "@/server/watch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 会话列表（轻量，供手表首页轮询刷新未读/预览）。 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const items = await listWatchConversations(user.id);
    return ok({ conversations: items });
  } catch (e) {
    // 兜底状态码不能是 401：手表把 401 视为登录失效会直接踢回登录页，
    // 数据库抖动等瞬时错误会因此误判为掉登录。真正的 AUTH_ERROR 由 fail() 内部映射为 401。
    return fail(e);
  }
}
