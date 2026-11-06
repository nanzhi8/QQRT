import { sendText } from "@/server/botManager";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { parseConversationId } from "@/server/repo";
import { watchMessageJson } from "@/server/watch";
import type { MessageRow } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 手表发送文本消息，支持引用回复（replyTo）与 @成员（mentions）。
 * GET 形式供下载通道兜底（fetch 不可用时，download 只能发 GET）。
 */
async function handle(req: Request, useQuery: boolean) {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const body = useQuery ? {} : ((await req.json().catch(() => ({}))) as { conversationId?: string; text?: string; replyTo?: string | null; mentions?: Array<{ openid: string; name?: string | null }> });
  const conversationId = (body.conversationId || url.searchParams.get("conversationId") || "").trim();
  const text = ((body.text ?? url.searchParams.get("text")) || "").trim();
  const replyTo = body.replyTo ?? url.searchParams.get("replyTo") ?? null;
  const mentions = Array.isArray(body.mentions) ? body.mentions : [];
  if (!conversationId) return fail(new Error("缺少会话 ID"), 400);
  if (!text && mentions.length === 0) return fail(new Error("消息内容不能为空"), 400);
  const parsed = parseConversationId(conversationId);
  if (!parsed) return fail(new Error("会话 ID 无效"), 400);
  try {
    const message = await sendText(user.id, parsed.scope, parsed.peerId, { text, replyTo, mentions });
    return ok({ message: watchMessageJson(message as unknown as MessageRow) });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  return handle(req, false);
}

export async function GET(req: Request) {
  return handle(req, true);
}
