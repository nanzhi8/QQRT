/**
 * QQ 群聊管理接口全集（官方文档 2026-09/10 版）
 *
 * 文档：https://bot.q.qq.com/wiki/develop/api-v2/
 *   左侧「服务端接口 → 群聊管理」；页面在 /autogen/api/<slug>.<method>.html
 *
 * 这里只做「透传 + 参数整形」，不缓存业务数据；所有调用都走 bot.api（自动带 AccessToken）。
 */
import { requireBot } from "./botManager";

export type GroupOp = "mute" | "unmute" | "kick" | "blacklist" | "unblacklist";

export interface GroupOpArgs {
  memberOpenid: string;
  seconds?: number;
  blacklist?: boolean;
}

const MAX_MUTE_SECONDS = 30 * 24 * 3600;

function rfc3339After(seconds: number): string {
  const d = new Date(Date.now() + seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const off = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off}`;
}

function explain(e: unknown): Error {
  const raw = e instanceof Error ? e.message : String(e);
  // 官方 SDK 形如：API Error [/v2/groups/xxx/members]: 应用无接口访问权限
  const m = raw.match(/API Error \[([^\]]*)\]:\s*([\s\S]+)$/);
  const reason = m ? m[2].trim() : raw;

  // 1) 白名单：必须排在「权限」之前，否则「无接口访问权限」会被误判成「不是管理员」
  if (/11253/.test(raw) || /无接口访问权限|仅白名单|白名单机器人/.test(reason)) {
    return new Error(
      "QQ 不让我做这个操作：该接口只对申请过白名单的机器人开放，需发邮件到 qq_open@tencent.com 申请「群成员管理」权限",
    );
  }
  // 2) 真的不是管理员
  if (/不是该群管理员|非群管理员|机器人.*管理员/.test(reason)) {
    return new Error("我在这个群没有管理员身份，请先在 QQ 群里把我设为管理员");
  }
  // 3) 群/资源不存在
  if (/不存在|已注销|已解散|已退出/.test(reason)) {
    return new Error("找不到这个群：可能我已经被移出，或群已解散");
  }
  // 4) 频率限制
  if (/频繁|频率|too many|rate limit/i.test(reason)) {
    return new Error("操作太频繁了，等 1 分钟再试");
  }
  // 5) 403
  if (/403|forbidden/i.test(raw)) {
    return new Error("QQ 拒绝了这个请求：我在这个群权限不够");
  }
  const clean = reason.replace(/\s+/g, " ").slice(0, 80);
  return new Error(clean || "操作失败");
}

async function call<T>(userId: string, fn: (bot: ReturnType<typeof requireBot>) => Promise<T>): Promise<T> {
  try {
    return await fn(requireBot(userId));
  } catch (e) {
    throw explain(e);
  }
}

/* ---------------- 只读接口 ---------------- */

export function getGroupInfo(userId: string, g: string) {
  return call(userId, (bot) => bot.api.get(`/v2/groups/${encodeURIComponent(g)}/info`));
}

export function getBotState(userId: string, g: string) {
  return call(userId, (bot) => bot.api.get(`/v2/groups/${encodeURIComponent(g)}/bot_state`));
}

export function getJoinRequests(userId: string, g: string, cursor = "", limit = 20) {
  return call(userId, (bot) => bot.api.get(`/v2/groups/${encodeURIComponent(g)}/join_request_list`, { cursor, limit }));
}

/** 查询全员禁言规则与当前禁言名单 */
export function getMuteState(userId: string, g: string) {
  return call(userId, (bot) => bot.api.get(`/v2/groups/${encodeURIComponent(g)}/restrict_chat_setting`));
}

/** 成员列表（分页，单次最多 30 条） */
export function listMembers(userId: string, g: string, cursor = "") {
  return call(userId, (bot) => bot.api.get(`/v2/groups/${encodeURIComponent(g)}/members`, { cursor }));
}

export function getMember(userId: string, g: string, memberOpenid: string) {
  return call(userId, (bot) =>
    bot.api.get(`/v2/groups/${encodeURIComponent(g)}/members/${encodeURIComponent(memberOpenid)}`),
  );
}

export function getBlacklist(userId: string, g: string, cursor = "", limit = 20) {
  return call(userId, (bot) =>
    bot.api.get(`/v2/groups/${encodeURIComponent(g)}/member_blacklist`, { cursor, limit }),
  );
}

/* ---------------- 入群自动审批策略 ---------------- */

export function getStrategies(userId: string, cursor = "", limit = 20) {
  return call(userId, (bot) => bot.api.get(`/v2/groups/join_approval_strategy`, { cursor, limit }));
}

/** 创建策略：给本群开启自动同意入群 */
export function createStrategy(
  userId: string,
  g: string,
  opts: { remark?: string; isEnable?: "on" | "off"; expireAt?: string } = {},
) {
  return call(userId, (bot) =>
    bot.api.post(`/v2/groups/join_approval_strategy`, {
      group_openids: [g],
      is_enable: opts.isEnable || "on",
      ...(opts.expireAt ? { expire_at: opts.expireAt } : {}),
      ...(opts.remark ? { remark: opts.remark } : {}),
    }),
  );
}

export function patchStrategy(userId: string, id: string, patch: Record<string, unknown>) {
  return call(userId, (bot) => bot.api.patch(`/v2/groups/join_approval_strategy/${encodeURIComponent(id)}`, patch));
}

export function deleteStrategy(userId: string, id: string) {
  return call(userId, (bot) => bot.api.delete(`/v2/groups/join_approval_strategy/${encodeURIComponent(id)}`));
}

export function executeStrategy(userId: string, id: string) {
  return call(userId, (bot) => bot.api.post(`/v2/groups/join_approval_strategy/${encodeURIComponent(id)}/execute`, {}));
}

/** QQ 号白名单增删（字符串避免 JS 精度问题） */
export function strategyWhitelist(userId: string, id: string, op: "add" | "del", qqs: string[]) {
  return call(userId, (bot) =>
    bot.api.post(`/v2/groups/join_approval_strategy/${encodeURIComponent(id)}/whitelist_users`, {
      op,
      whitelist_users: qqs,
    }),
  );
}

/* ---------------- 写操作 ---------------- */

export async function runGroupOp(userId: string, groupOpenid: string, op: GroupOp, args: GroupOpArgs) {
  const g = encodeURIComponent(groupOpenid);
  const member = String(args.memberOpenid || "");
  if (!member) throw new Error("缺少成员 ID");

  return call(userId, async (bot) => {
    if (op === "mute" || op === "unmute") {
      const seconds = op === "unmute" ? 0 : Math.max(1, Math.min(MAX_MUTE_SECONDS, args.seconds || 0));
      await bot.api.post(`/v2/groups/${g}/restrict_chat_setting`, {
        members: [
          op === "unmute"
            ? { op: "del", member_openid: member, mute_expire_at: "" }
            : { op: "add", member_openid: member, mute_expire_at: rfc3339After(seconds) },
        ],
      });
      return { ok: true };
    }
    if (op === "kick") {
      await bot.api.post(`/v2/groups/${g}/batch_remove_members`, {
        member_openids: [member],
        add_to_member_blacklist: !!args.blacklist,
      });
      return { ok: true };
    }
    await bot.api.post(`/v2/groups/${g}/member_blacklist`, {
      op: op === "blacklist" ? "add" : "del",
      member_openids: [member],
    });
    return { ok: true };
  });
}

/** 入群申请审批 */
export function approveJoinRequest(
  userId: string,
  g: string,
  memberOpenid: string,
  action: "approve" | "decline",
  reason?: string,
) {
  return call(userId, (bot) =>
    bot.api.post(
      `/v2/groups/${encodeURIComponent(g)}/approval_join_request/${encodeURIComponent(memberOpenid)}`,
      { action, ...(reason ? { reason } : {}) },
    ),
  );
}
