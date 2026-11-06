import { fail, ok, requireUser } from "@/server/httpUtil";
import { markWatchRead } from "@/server/watch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 标记会话已读（清除未读红点）。 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const body = (await req.json().catch(() => ({}))) as { conversationId?: string };
    const conversationId = body.conversationId || url.searchParams.get("conversationId") || "";
    if (!conversationId) return fail(new Error("缺少会话 ID"), 400);
    await markWatchRead(user.id, conversationId);
    return ok({ ok: true });
  } catch (e) {
    // 兜底状态码不能是 401：手表把 401 视为登录失效会直接踢回登录页，
    // 数据库抖动等瞬时错误会因此误判为掉登录。真正的 AUTH_ERROR 由 fail() 内部映射为 401。
    return fail(e);
  }
}

export async function GET(req: Request) {
  return POST(req);
}
