import { appError } from "@/lib/errors";
import { fail, ok, readJson, requireUser } from "@/server/httpUtil";
import { parseConversationId } from "@/server/repo";
import { recordLocalClick } from "@/server/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手表端点击自己消息里的按钮（QQ 端点击走 INTERACTION_CREATE，不走这里） */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const b = await readJson<{ conversationId?: string; label?: string; data?: string }>(req);
    const parsed = String(b.conversationId || "").trim() ? parseConversationId(String(b.conversationId).trim()) : null;
    if (!parsed || (parsed.scope !== "group" && parsed.scope !== "c2c")) {
      throw appError("INVALID_REQUEST", "无效的会话 ID", "");
    }
    await recordLocalClick(
      user.id,
      parsed.scope as "group" | "c2c",
      parsed.peerId,
      String(b.label || ""),
      String(b.data || ""),
    );
    return ok({ clicked: true });
  } catch (e) {
    return fail(e);
  }
}
