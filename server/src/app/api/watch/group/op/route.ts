import { appError } from "@/lib/errors";
import { fail, ok, readJson, requireUser } from "@/server/httpUtil";
import { parseConversationId } from "@/server/repo";
import { runGroupOp, type GroupOp } from "@/server/qqGroup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS: GroupOp[] = ["mute", "unmute", "kick", "blacklist", "unblacklist"];

/**
 * 群管理操作：禁言 / 解除禁言 / 移出群聊 / 拉黑 / 解除拉黑。
 * 需要机器人是该群管理员；踢人与黑名单属白名单能力（未开通返回 11253）。
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = await readJson<{
      conversationId?: string;
      memberOpenid?: string;
      action?: string;
      seconds?: number;
      blacklist?: boolean;
    }>(req);

    const conversationId = String(body.conversationId || "").trim();
    const memberOpenid = String(body.memberOpenid || "").trim();
    const action = String(body.action || "").trim() as GroupOp;
    const seconds = Math.max(0, Math.min(30 * 24 * 3600, Number(body.seconds) || 0));

    if (!conversationId) throw appError("INVALID_REQUEST", "缺少会话 ID", "");
    if (!memberOpenid) throw appError("INVALID_REQUEST", "缺少成员 ID", "");
    if (!ACTIONS.includes(action)) throw appError("INVALID_REQUEST", "不支持的操作", "");

    const parsed = parseConversationId(conversationId);
    if (!parsed || parsed.scope !== "group") {
      throw appError("INVALID_REQUEST", "仅群聊支持该操作", "");
    }

    await runGroupOp(user.id, parsed.peerId, action, {
      memberOpenid,
      seconds,
      blacklist: !!body.blacklist,
    });
    return ok({ action });
  } catch (e) {
    return fail(e);
  }
}
