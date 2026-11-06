import { appError } from "@/lib/errors";
import { fail, ok, readJson, requireUser } from "@/server/httpUtil";
import { parseConversationId } from "@/server/repo";
import { sendButtonMessage, type ButtonDef } from "@/server/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手表发起一条带按钮的消息；按钮在 QQ 端点击，回调会变成聊天里的系统提示 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const b = await readJson<{
      conversationId?: string;
      text?: string;
      buttons?: Array<{ id?: string; label?: string; data?: string; style?: number }>;
    }>(req);

    const conversationId = String(b.conversationId || "").trim();
    const text = String(b.text || "").trim();
    const parsed = conversationId ? parseConversationId(conversationId) : null;
    if (!parsed || (parsed.scope !== "group" && parsed.scope !== "c2c")) {
      throw appError("INVALID_REQUEST", "无效的会话 ID", "");
    }
    if (!text) throw appError("INVALID_REQUEST", "消息内容不能为空", "");

    const buttons: ButtonDef[] = (Array.isArray(b.buttons) ? b.buttons : [])
      .filter((x) => x && x.label)
      .slice(0, 6)
      .map((x, i) => ({
        id: String(x.id || `btn${i + 1}`),
        label: String(x.label).slice(0, 10),
        data: String(x.data || String(x.label)).slice(0, 80),
        style: ([0, 1, 3, 4].includes(Number(x.style)) ? Number(x.style) : 1) as 0 | 1 | 3 | 4,
      }));
    if (!buttons.length) throw appError("INVALID_REQUEST", "至少需要一个按钮", "");

    await sendButtonMessage(user.id, parsed.scope as "group" | "c2c", parsed.peerId, text, buttons);
    return ok({ sent: true, buttons: buttons.length });
  } catch (e) {
    return fail(e);
  }
}
