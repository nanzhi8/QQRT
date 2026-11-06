/**
 * QQ 官方事件补全 + 按钮消息交互回调
 *
 * 官方文档：
 *  - 事件页 /develop/api-v2/autogen/event/<event>.html
 *  - 互动回调 PUT /interactions/{interaction_id}  { code: 0 }
 *  - 按钮消息 POST /v2/groups/{g}/messages  body.keyboard.content.rows[].buttons[]
 *
 * 本模块只负责：把事件变成会话里的一条「系统提示」消息（幂等），以及
 * 处理 INTERACTION_CREATE 的回调；不改动原有四个事件的处理逻辑。
 */
import { bus } from "@/lib/bus";
import { log } from "@/lib/logger";
import {
  convId,
  ensureConversation,
  getConversation,
  insertMessage,
  touchConversation,
} from "./repo";
import { requireBot } from "./botManager";

interface Tip {
  scope: "group" | "c2c";
  peerId: string;
  text: string;
  key: string;
  ts: number;
}

function epoch(t: unknown): number {
  if (typeof t === "number") return t > 1e12 ? Math.floor(t / 1000) : t;
  if (typeof t === "string") {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
    const n = Number(t);
    if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : n;
  }
  return Math.floor(Date.now() / 1000);
}

function now(): number {
  return Date.now();
}

/** 落一条系统提示消息；qqMessageId 用事件指纹保证重复推送不会刷屏 */
async function pushTip(userId: string, tip: Tip): Promise<boolean> {
  const id = convId(tip.scope, tip.peerId);
  await ensureConversation(userId, {
    id,
    scope: tip.scope,
    peerId: tip.peerId,
    title: tip.scope === "group" ? "QQ 群聊" : "QQ 好友",
    lastMessageAt: tip.ts * 1000,
  });
  const { row, duplicate } = await insertMessage({
    userId,
    qqMessageId: `evt:${tip.key}`,
    conversationId: id,
    scope: tip.scope,
    peerId: tip.peerId,
    direction: "in",
    senderId: null,
    senderName: null,
    msgType: "system",
    text: tip.text,
    status: "sent",
    createdAt: tip.ts * 1000,
  });
  if (duplicate) return false;
  const conv = await touchConversation(userId, id, {
    lastMessageAt: tip.ts * 1000,
    lastPreview: tip.text,
    incrUnread: false,
  });
  bus.emit(userId, "message", { message: row, conversation: conv || (await getConversation(userId, id)) });
  return true;
}

/** 手表端本地点按钮：QQ 端不会给回调，这里自己落一条提示，形成闭环 */
export async function recordLocalClick(
  userId: string,
  scope: "group" | "c2c",
  peerId: string,
  label: string,
  data: string,
): Promise<void> {
  const key = `local:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  await pushTip(userId, {
    scope,
    peerId,
    text: `你点击了【${String(label || data || "按钮").slice(0, 12)}】`,
    key,
    ts: Math.floor(Date.now() / 1000),
  });
  bus.emit(userId, "interaction", { interactionId: "", buttonId: "", buttonData: data, scope, peer: peerId });
}

/** 交互回调：告诉 QQ 我们收到了（不 ack 按钮会一直转圈） */
export async function ackInteraction(userId: string, interactionId: string, code = 0): Promise<void> {
  if (!interactionId) return;
  const bot = requireBot(userId);
  try {
    await bot.api.put(`/interactions/${encodeURIComponent(interactionId)}`, { code });
  } catch (e) {
    log.warn(`ack interaction ${interactionId} failed`, e);
  }
}

/** 按钮消息：一行一个按钮组，按钮数据会原样回传到 INTERACTION_CREATE */
export interface ButtonDef {
  id: string;
  label: string;
  data: string;
  style?: 0 | 1 | 3 | 4;
  visitedLabel?: string;
}

export async function sendButtonMessage(
  userId: string,
  scope: "group" | "c2c",
  peerId: string,
  text: string,
  buttons: ButtonDef[],
): Promise<unknown> {
  const bot = requireBot(userId);
  const rows = [{
    buttons: buttons.slice(0, 6).map((b) => ({
      id: b.id,
      render_data: {
        label: b.label.slice(0, 10),
        visited_label: (b.visitedLabel || b.label).slice(0, 10),
        style: b.style ?? 1,
      },
      action: { type: 1, data: b.data },
    })),
  }];
  const path = scope === "group"
    ? `/v2/groups/${encodeURIComponent(peerId)}/messages`
    : `/v2/users/${encodeURIComponent(peerId)}/messages`;

  const res = await bot.api.post(path, {
    msg_type: 0,
    content: String(text || "").slice(0, 200),
    keyboard: { content: { rows } },
  });

  // 本端也留一条记录，好让手表知道发出去了什么（键盘定义存在附件元数据里）
  const conversationId = convId(scope, peerId);
  await ensureConversation(userId, {
    id: conversationId,
    scope,
    peerId,
    title: scope === "group" ? "QQ 群聊" : "QQ 好友",
    lastMessageAt: now(),
  });
  const meta = {
    kind: "keyboard",
    contentType: "application/x-qqrt-keyboard",
    filename: "keyboard.json",
    text,
    buttons,
  };
  const { row } = await insertMessage({
    userId,
    qqMessageId: `kbd:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    conversationId,
    scope,
    peerId,
    direction: "out",
    msgType: "keyboard",
    text,
    attachments: [meta as unknown as { contentType: string }],
    status: "sent",
    createdAt: now(),
  });
  const conv = await touchConversation(userId, conversationId, {
    lastMessageAt: now(),
    lastPreview: text,
    incrUnread: false,
  });
  bus.emit(userId, "message", { message: row, conversation: conv || (await getConversation(userId, conversationId)) });
  return res;
}

/**
 * 处理新增事件；返回 true 表示已消费。
 * botManager 原有的四个事件（FRIEND_ADD / GROUP_ADD_ROBOT / GROUP_DEL_ROBOT /
 * GROUP_JOIN_REQUEST）不在这里处理。
 */
export async function handleExtraEvent(userId: string, eventType: string, data: unknown): Promise<boolean> {
  const d = (data || {}) as Record<string, unknown>;
  const ts = epoch(d.timestamp);
  const str = (k: string) => String(d[k] ?? "");

  if (eventType === "INTERACTION_CREATE") return handleInteraction(userId, d);

  const group = str("group_openid");
  const openid = str("openid") || str("user_openid");
  const member = str("member_openid") || str("op_member_openid") || str("group_member_openid");
  let tip: Tip | null = null;

  switch (eventType) {
    case "FRIEND_DEL":
      if (openid) tip = { scope: "c2c", peerId: openid, text: "对方已删除好友", key: `fd:${openid}:${ts}`, ts };
      break;
    case "GROUP_MEMBER_ADD":
      if (group) tip = { scope: "group", peerId: group, text: "有新成员加入群聊", key: `gma:${group}:${member}:${ts}`, ts };
      break;
    case "GROUP_MEMBER_REMOVE":
      if (group) tip = { scope: "group", peerId: group, text: "有成员退出了群聊", key: `gmr:${group}:${member}:${ts}`, ts };
      break;
    case "C2C_MSG_REJECT":
      if (openid) tip = { scope: "c2c", peerId: openid, text: "对方关闭了消息接收", key: `c2cr:${openid}:${ts}`, ts };
      break;
    case "C2C_MSG_RECEIVE":
      if (openid) tip = { scope: "c2c", peerId: openid, text: "对方开启了消息接收", key: `c2ca:${openid}:${ts}`, ts };
      break;
    case "GROUP_MSG_REJECT":
      if (group) tip = { scope: "group", peerId: group, text: "群内关闭了消息接收", key: `gmrj:${group}:${ts}`, ts };
      break;
    case "GROUP_MSG_RECEIVE":
      if (group) tip = { scope: "group", peerId: group, text: "群内开启了消息接收", key: `gmra:${group}:${ts}`, ts };
      break;
    case "SUBSCRIBE_MESSAGE_STATUS": {
      const results = Array.isArray(d.result) ? d.result : [];
      const allowed = results.some((r) => Number((r as Record<string, unknown>)?.op) === 1);
      const peer = group || openid;
      if (peer) tip = {
        scope: group ? "group" : "c2c",
        peerId: peer,
        text: allowed ? "已允许订阅消息" : "已拒绝订阅消息",
        key: `sms:${peer}:${ts}:${allowed}`,
        ts,
      };
      break;
    }
    default:
      return false;
  }

  if (!tip) return false;
  await pushTip(userId, tip);
  log.info(`${eventType} -> tip: ${tip.text}`);
  return true;
}

/** INTERACTION_CREATE：type=11 为按钮点击 */
async function handleInteraction(userId: string, d: Record<string, unknown>): Promise<boolean> {
  const type = Number(d.type ?? 0);
  if (type !== 11) return false;
  const interactionId = String(d.id ?? "");
  const resolved = ((d.data as Record<string, unknown>)?.resolved || {}) as Record<string, unknown>;
  const buttonId = String(resolved.button_id ?? "");
  const buttonData = String(resolved.button_data ?? "");
  const label = buttonId || buttonData || "按钮";

  // 先 ack，避免 QQ 端按钮一直转圈
  await ackInteraction(userId, interactionId, 0);

  const group = String(d.group_openid ?? "");
  const scope: "group" | "c2c" = group ? "group" : "c2c";
  const peer = group || String(d.user_openid ?? "");
  const who = String(d.group_member_openid ?? d.user_openid ?? "").slice(-6) || "有人";
  if (!peer) return true;

  // 约定按钮 data 形如 "approve:xxx" / "vote:xxx"，这里只做提示，业务动作由路由层扩展
  await pushTip(userId, {
    scope,
    peerId: peer,
    text: `${who} 点击了【${label.slice(0, 12)}】`,
    key: `itx:${interactionId}`,
    ts: epoch(d.timestamp ?? Math.floor(Date.now() / 1000)),
  });
  bus.emit(userId, "interaction", { interactionId, buttonId, buttonData, scope, peer });
  log.info(`INTERACTION_CREATE ${buttonId} / ${buttonData}`);
  return true;
}
