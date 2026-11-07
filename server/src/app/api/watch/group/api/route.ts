import { appError } from "@/lib/errors";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { fail, ok, readJson, requireUser } from "@/server/httpUtil";
import { parseConversationId } from "@/server/repo";
import {
  getGroupInfo,
  getBotState,
  getJoinRequests,
  getMuteState,
  listMembers,
  getMember,
  getBlacklist,
  getStrategies,
  createStrategy,
  patchStrategy,
  deleteStrategy,
  executeStrategy,
  strategyWhitelist,
  runGroupOp,
  approveJoinRequest,
  type GroupOp,
} from "@/server/qqGroup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Req = {
  action?: string;
  conversationId?: string;
  memberOpenid?: string;
  cursor?: string;
  limit?: number;
  seconds?: number;
  blacklist?: boolean;
  strategyId?: string;
  patch?: Record<string, unknown>;
  op?: "add" | "del";
  qqs?: string[];
  reason?: string;
  decision?: "approve" | "decline";
  remark?: string;
};

/** 把任意 JSON 摊平成手表端好画的 key/value 列表 */
function rows(obj: unknown, max = 40): Array<{ k: string; v: string }> {
  if (!obj || typeof obj !== "object") return [{ k: "结果", v: String(obj ?? "无数据") }];
  const out: Array<{ k: string; v: string }> = [];
  const walk = (o: unknown, prefix: string) => {
    if (out.length >= max) return;
    if (Array.isArray(o)) {
      o.slice(0, 12).forEach((item, i) => walk(item, `${prefix}[${i + 1}]`));
      if (o.length > 12) out.push({ k: `${prefix}…`, v: `共 ${o.length} 条` });
      return;
    }
    if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (out.length >= max) return;
        walk(v, prefix ? `${prefix}.${k}` : k);
      }
      return;
    }
    out.push({ k: prefix || "值", v: o === null || o === undefined || o === "" ? "—" : String(o).slice(0, 60) });
  };
  walk(obj, "");
  return out.length ? out : [{ k: "结果", v: "无数据" }];
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const b = await readJson<Req>(req);
    const action = String(b.action || "").trim();
    const conversationId = String(b.conversationId || "").trim();
    const parsed = conversationId ? parseConversationId(conversationId) : null;
    const g = parsed?.scope === "group" ? parsed.peerId : "";
    const memberOpenid = String(b.memberOpenid || "").trim();

    // 不需要群 ID 的：策略列表 / 策略操作
    if (action === "strategies") {
      const r = await getStrategies(user.id, String(b.cursor || ""), Number(b.limit) || 20);
      return ok({ rows: rows(r), raw: r });
    }
    if (action === "strategy_create") {
      if (!g) throw appError("INVALID_REQUEST", "需要群聊会话", "");
      const r = await createStrategy(user.id, g, { remark: b.remark });
      return ok({ rows: rows(r), raw: r });
    }
    if (action === "strategy_patch" || action === "strategy_delete" || action === "strategy_execute" || action === "strategy_whitelist") {
      const id = String(b.strategyId || "").trim();
      if (!id) throw appError("INVALID_REQUEST", "缺少策略 ID", "");
      let r: unknown;
      if (action === "strategy_patch") r = await patchStrategy(user.id, id, b.patch || {});
      else if (action === "strategy_delete") r = await deleteStrategy(user.id, id);
      else if (action === "strategy_execute") r = await executeStrategy(user.id, id);
      else r = await strategyWhitelist(user.id, id, b.op || "add", Array.isArray(b.qqs) ? b.qqs : []);
      return ok({ rows: rows(r), raw: r });
    }

    // 以下都需要群聊会话
    if (!g) throw appError("INVALID_REQUEST", "仅群聊支持该操作（缺少有效的群会话 ID）", "");

    /**
     * 从本地消息里捞「最近说过话的人」。
     * 官方成员列表接口需要 11253 白名单，没开通时手表就选不了人、也就没法禁言。
     * 这个动作纯查本地库，不依赖任何官方权限。
     */
    if (action === "recent_senders") {
      const rows = await db
        .select({ senderId: messages.senderId, senderName: messages.senderName })
        .from(messages)
        .where(
          and(
            eq(messages.userId, user.id),
            eq(messages.conversationId, conversationId),
            eq(messages.direction, "in"),
          ),
        )
        .orderBy(desc(messages.seq))
        .limit(300);
      const seen = new Set<string>();
      const out: Array<{ openid: string; name: string }> = [];
      for (const r of rows) {
        const id = String(r.senderId ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({ openid: id, name: String(r.senderName ?? "") });
        if (out.length >= 50) break;
      }
      return ok({ members: out, source: "recent" });
    }

    let r: unknown;
    switch (action) {
      case "info": r = await getGroupInfo(user.id, g); break;
      case "bot_state": r = await getBotState(user.id, g); break;
      case "join_requests": r = await getJoinRequests(user.id, g, String(b.cursor || ""), Number(b.limit) || 20); break;
      case "mute_state": r = await getMuteState(user.id, g); break;
      case "members": r = await listMembers(user.id, g, String(b.cursor || "")); break;
      case "member": {
        if (!memberOpenid) throw appError("INVALID_REQUEST", "缺少成员 ID", "");
        r = await getMember(user.id, g, memberOpenid); break;
      }
      case "blacklist": r = await getBlacklist(user.id, g, String(b.cursor || ""), Number(b.limit) || 20); break;
      case "op": break;
      case "approve": {
        if (!memberOpenid) throw appError("INVALID_REQUEST", "缺少申请人 ID", "");
        r = await approveJoinRequest(user.id, g, memberOpenid, b.decision === "decline" ? "decline" : "approve", b.reason);
        break;
      }
      default: throw appError("INVALID_REQUEST", "不支持的操作：" + action, "");
    }

    if (action === "op") {
      const memberAction = String((b as unknown as Record<string, unknown>).memberAction || "") as GroupOp;
      if (!["mute", "unmute", "kick", "blacklist", "unblacklist"].includes(memberAction)) {
        throw appError("INVALID_REQUEST", "不支持的成员操作", "");
      }
      if (!memberOpenid) throw appError("INVALID_REQUEST", "缺少成员 ID", "");
      await runGroupOp(user.id, g, memberAction, {
        memberOpenid,
        seconds: Number(b.seconds) || 0,
        blacklist: !!b.blacklist,
      });
      return ok({ rows: [{ k: "操作", v: "成功" }] });
    }

    return ok({ rows: rows(r), raw: r });
  } catch (e) {
    return fail(e);
  }
}
