import { sendRichText } from "@/server/botManager";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { outPathFor } from "@/server/media";
import { parseConversationId, type Scope } from "@/server/repo";
import { watchMessageJson } from "@/server/watch";
import type { MessageRow } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 手表图文消息：文字 + 已上传图片（localIds）+ @成员，一条 Markdown 发出。
 * 图片地址由服务端拼成公网可访问 URL，QQ 会下载转存。
 * 注意：服务器必须能被 QQ 公网访问到，否则图片发送失败。
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as {
      conversationId?: string;
      text?: string;
      localIds?: string[];
      mentions?: Array<{ openid: string; name?: string | null }>;
    };
    const conversationId = body.conversationId || "";
    if (!conversationId) return fail(new Error("缺少会话 ID"), 400);
    const parsed = parseConversationId(conversationId);
    if (!parsed) return fail(new Error("会话 ID 无效"), 400);
    const localIds = Array.isArray(body.localIds) ? body.localIds.filter(Boolean).slice(0, 9) : [];
    if (localIds.length === 0 && !(body.text || "").trim()) {
      return fail(new Error("图文消息内容不能为空"), 400);
    }

    const fwdProto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
    const proto = fwdProto || (req.url.startsWith("https:") ? "https" : "http");
    const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
    if (!host) return fail(new Error("无法确定服务器公网地址"), 400);
    const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");
    const imageUrls: string[] = [];
    for (const localId of localIds) {
      if (!outPathFor(localId)) return fail(new Error("有图片已过期，请重新选择"), 400);
      imageUrls.push(`${proto}://${host}${basePath}/api/watch/pub/${encodeURIComponent(localId)}`);
    }

    const message = await sendRichText(user.id, parsed.scope as Scope, parsed.peerId, {
      text: body.text ?? "",
      imageUrls,
      mentions: Array.isArray(body.mentions) ? body.mentions : [],
    });
    return ok({ message: watchMessageJson(message as unknown as MessageRow) });
  } catch (e) {
    return fail(e);
  }
}
