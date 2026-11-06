import { sendMedia } from "@/server/botManager";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { outPathFor } from "@/server/media";
import { parseConversationId, type Scope } from "@/server/repo";
import { watchMessageJson } from "@/server/watch";
import type { MessageRow } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手表发送已上传的媒体（图片/语音）：localId 来自 /api/watch/upload。 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as {
      conversationId?: string;
      localId?: string;
      fileName?: string;
      contentType?: string;
      size?: number;
      kind?: string;
      replyTo?: string | null;
    };
    const conversationId = body.conversationId || "";
    const localId = body.localId || "";
    const kind = body.kind === "voice" ? "voice" : body.kind === "video" ? "video" : body.kind === "file" ? "file" : "image";
    if (!conversationId) return fail(new Error("缺少会话 ID"), 400);
    if (!localId) return fail(new Error("缺少上传文件 ID"), 400);
    const parsed = parseConversationId(conversationId);
    if (!parsed) return fail(new Error("会话 ID 无效"), 400);
    const localPath = outPathFor(localId);
    if (!localPath) return fail(new Error("上传文件不存在或已过期"), 400);
    const message = await sendMedia(user.id, parsed.scope as Scope, parsed.peerId, {
      localPath,
      localId,
      fileName: body.fileName || localId,
      contentType: body.contentType || "application/octet-stream",
      size: body.size,
      kind,
      replyTo: body.replyTo ?? null,
    });
    return ok({ message: watchMessageJson(message as unknown as MessageRow) });
  } catch (e) {
    return fail(e);
  }
}
