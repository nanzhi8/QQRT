import { fail, ok, requireUser } from "@/server/httpUtil";
import { bus } from "@/lib/bus";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 仅用于自动化测试/联调的事件注入入口（生产环境 404）。
 *
 * 端到端验证需要一条「真实触发 bus.emit('message')」的路径，用于证明
 * 长轮询 waitForWatchMessages 的事件唤醒主路径（<1s）与 vc19 的 touched
 * 通路在部署形态下真实可用。psql 直插绕过了 emit，测不到这条链路。
 * 该路由在生产环境（NODE_ENV=production 且未显式放行）直接返回 404。
 */
function devAllowed(): boolean {
  if (process.env.QQRT_ALLOW_DEV_ROUTES === "1") return true;
  return process.env.NODE_ENV !== "production";
}

export async function POST(req: Request) {
  if (!devAllowed()) return new Response("Not Found", { status: 404 });
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as {
      conversationId?: string;
      seq?: number;
      text?: string;
    };
    const conversationId = body.conversationId || "";
    if (!conversationId) return fail(new Error("缺少会话 ID"), 400);
    const message = {
      conversationId,
      seq: Number(body.seq || 0) || Number.MAX_SAFE_INTEGER - 1,
      text: body.text ?? "bus-emit-test",
    };
    // 与 botManager.emitMessage 相同的事件形态（type=message, data.message）
    bus.emit(user.id, "message", { message, conversation: null });
    log.debug("dev emit-test fired", { userId: user.id, conversationId });
    return ok({ emitted: true });
  } catch (e) {
    return fail(e);
  }
}
