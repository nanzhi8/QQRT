import { fail, ok, requireUser } from "@/server/httpUtil";
import { insertMessage, parseConversationId } from "@/server/repo";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 仅用于自动化测试的落库入口（生产环境 404）。
 *
 * 端到端 harness 需要一个「走真实 insertMessage → prune 管线」的入口，
 * 才能验证 bug#7（自动清理开关关闭后服务端不得再裁剪消息）。
 * 该路由在生产环境（NODE_ENV=production 且未显式放行）直接返回 404，
 * 不会暴露任何写库能力。
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
      conversation?: string;
      text?: string;
      direction?: "in" | "out";
      msgType?: string;
      peerId?: string;
      scope?: string;
      senderName?: string;
    };
    const conversation = body.conversationId || body.conversation || "c2c:testpeer";
    const parsed = parseConversationId(conversation);
    const scope = (body.scope as "c2c" | "group") || parsed?.scope || "c2c";
    const peerId = body.peerId || parsed?.peerId || "testpeer";
    const { row } = await insertMessage({
      userId: user.id,
      conversationId: conversation,
      scope,
      peerId,
      direction: body.direction || "in",
      senderName: body.senderName || "测试好友",
      msgType: body.msgType || "text",
      text: body.text ?? "dev",
      attachments: [],
      status: "sent",
      createdAt: Date.now(),
    });
    return ok({ id: row.id });
  } catch (e) {
    log.warn("dev insert-message failed", e);
    return fail(e);
  }
}
