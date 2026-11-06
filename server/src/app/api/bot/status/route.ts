import { ensureBoot, statusPayload } from "@/server/botManager";
import { fail, ok, requireUser } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    ensureBoot();
    return ok({ status: await statusPayload(user.id) });
  } catch (e) {
    // 兜底状态码不能是 401：手表把 401 视为登录失效会直接踢回登录页，
    // 数据库抖动等瞬时错误会因此误判为掉登录。真正的 AUTH_ERROR 由 fail() 内部映射为 401。
    return fail(e);
  }
}
