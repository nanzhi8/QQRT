import { listGroupMembers } from "@/server/botManager";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { parseConversationId } from "@/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手表群成员列表（用于 @成员）。 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const conversationId = url.searchParams.get("conversationId") || "";
    if (!conversationId) return fail(new Error("缺少会话 ID"), 400);
    const parsed = parseConversationId(conversationId);
    if (!parsed || parsed.scope !== "group") return fail(new Error("仅群聊有成员列表"), 400);
    const members = await listGroupMembers(user.id, parsed.peerId);
    return ok({
      members: members.map((m) => ({ openid: m.openid, name: m.name, avatar: m.avatar ?? null })),
    });
  } catch (e) {
    return fail(e);
  }
}
