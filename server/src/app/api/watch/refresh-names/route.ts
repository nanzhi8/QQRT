import { displayTitleForGroup, requireBot } from "@/server/botManager";
import { fail, ok, requireUser } from "@/server/httpUtil";
import {
  getContact,
  getConversation,
  listConversations,
  updateConversationIdentity,
} from "@/server/repo";
import type { ConversationRow } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 刷新会话真实名称。
 *
 * - 群聊：走 `/v2/groups/{group_openid}/info` 拿群名（有缓存，24h）。
 * - 单聊：QQ 机器人接口不提供好友昵称（`/v2/users/{openid}` 返回 404 不支持的调用），
 *   只能用联系人缓存里的名字（来自群成员昵称或手动备注）。
 *
 * 只改 `title`，绝不动 `remark`（用户手动改的名字优先级最高）。
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { conversationId?: string };
    const only = String(body.conversationId || "");

    let convs: ConversationRow[] = [];
    if (only) {
      const one = await getConversation(user.id, only);
      if (one) convs = [one];
    } else {
      convs = await listConversations(user.id);
    }

    let bot = null;
    try {
      bot = requireBot(user.id);
    } catch {
      // 机器人未连接时只用缓存，不报错
    }

    let updated = 0;
    const names: Array<{ id: string; title: string }> = [];
    for (const conv of convs) {
      if (conv.remark) continue; // 有备注：不动
      let name = "";
      if (conv.scope === "group") {
        const resolved = await displayTitleForGroup(user.id, bot, conv.peerId);
        if (resolved && resolved !== "QQ 群聊") name = resolved;
      } else {
        const contact = await getContact(user.id, "user", conv.peerId);
        name = contact?.name?.trim() || "";
      }
      if (!name || name === conv.title) continue;
      const next = await updateConversationIdentity(user.id, conv.id, { title: name });
      if (next) {
        updated += 1;
        names.push({ id: conv.id, title: name });
      }
    }

    return ok({ updated, names });
  } catch (e) {
    return fail(e);
  }
}
