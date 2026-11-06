import { resendFailed } from "@/server/botManager";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { watchMessageJson } from "@/server/watch";
import type { MessageRow } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手表重发发送失败的消息。 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { messageId?: string };
    const messageId = body.messageId || "";
    if (!messageId) return fail(new Error("缺少消息 ID"), 400);
    const message = await resendFailed(user.id, messageId);
    return ok({ message: watchMessageJson(message as unknown as MessageRow) });
  } catch (e) {
    return fail(e);
  }
}
