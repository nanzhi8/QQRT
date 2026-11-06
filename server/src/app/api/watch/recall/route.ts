import { recallMessage } from "@/server/botManager";
import { fail, ok, requireUser } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手表撤回机器人已发送的消息。 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { messageId?: string };
    const messageId = body.messageId || "";
    if (!messageId) return fail(new Error("缺少消息 ID"), 400);
    await recallMessage(user.id, messageId);
    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
