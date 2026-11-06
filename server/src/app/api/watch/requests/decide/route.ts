import { decideJoinRequest } from "@/server/botManager";
import { fail, ok, requireUser } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手表审批入群申请：同意 / 拒绝。 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { id?: string; op?: string; reason?: string };
    if (!body.id) return fail(new Error("缺少申请 ID"), 400);
    if (body.op !== "approve" && body.op !== "decline") return fail(new Error("未知操作"), 400);
    const updated = await decideJoinRequest(user.id, body.id, body.op, body.reason);
    return ok({ request: updated });
  } catch (e) {
    return fail(e);
  }
}
