import { sendCommand } from "@/server/botManager";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { parseConversationId, type Scope } from "@/server/repo";
import { watchMessageJson } from "@/server/watch";
import type { MessageRow } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手表发送蓝色可点击指令（群聊填入输入框 / 私聊点击即发送）。 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { conversationId?: string; show?: string; command?: string };
    const conversationId = body.conversationId || "";
    if (!conversationId) return fail(new Error("缺少会话 ID"), 400);
    const parsed = parseConversationId(conversationId);
    if (!parsed) return fail(new Error("会话 ID 无效"), 400);
    const message = await sendCommand(user.id, parsed.scope as Scope, parsed.peerId, {
      show: body.show ?? "",
      command: body.command ?? "",
    });
    return ok({ message: watchMessageJson(message as unknown as MessageRow) });
  } catch (e) {
    return fail(e);
  }
}
