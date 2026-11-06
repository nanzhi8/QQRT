import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, type MessageRow } from "@/db/schema";
import { markRead } from "./repo";
import { bus } from "@/lib/bus";
import { watchMediaKind } from "./watchMedia";

/**
 * 手表端数据视图：把服务端完整数据裁剪成 240x240 设备能高效消费的轻量 JSON，
 * 并给附件挂上手表专用媒体地址（图片/语音走 media，视频走 video 清单）。
 */

export interface WatchAttachment {
  /** #13 text：手表可直接阅读的纯文本；file：其余暂不支持预览的类型。 */
  kind: "image" | "video" | "audio" | "text" | "file";
  contentType: string;
  filename?: string | null;
  /** 图片/语音：处理后的相对 URL；视频：分段清单相对 URL。 */
  watchUrl: string | null;
  /** 图片原始宽高（手表端按此比例排版；拿不到时为 null，客户端退回 1:1） */
  width?: number | null;
  height?: number | null;
  asrText?: string | null;
}

export interface WatchMessage {
  seq: number;
  id: string;
  conversationId: string;
  scope: string;
  direction: string;
  senderName: string | null;
  msgType: string;
  text: string | null;
  status: string;
  createdAt: number;
  replyPreview: string | null;
  /** 被引用消息的本地 id（出站引用才有，用于手表端跳转） */
  replyId: string | null;
  replySender: string | null;
  attachments: WatchAttachment[];
}

export interface WatchConversation {
  id: string;
  scope: string;
  peerId: string;
  title: string;
  unread: number;
  lastPreview: string;
  lastMessageAt: number;
}

function forwardTitle(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const card = JSON.parse(raw) as { title?: string };
    return card.title || "[聊天记录]";
  } catch {
    return "[聊天记录]";
  }
}

export function watchMessageJson(message: MessageRow): WatchMessage {
  const attachments: WatchAttachment[] = (message.attachments ?? []).map((att, index) => {
    const kind = watchMediaKind(att);
    // 每种类型落到各自的端点：视频走分段清单、文本走文本抽取、其余走媒体。
    // 手表端虽会自行拼 URL，但这里必须给出**正确**的地址，避免任何一处误用。
    const base =
      kind === "video"
        ? `/api/watch/video/${message.id}/${index}`
        : kind === "text"
          ? `/api/watch/text/${message.id}/${index}`
          : `/api/watch/media/${message.id}/${index}`;
    return {
      kind,
      contentType: att.contentType,
      filename: att.filename ?? null,
      watchUrl: kind === "file" ? null : base,
      width: att.width ?? null,
      height: att.height ?? null,
      asrText: att.asrText ?? null,
    };
  });

  const text = message.msgType === "forward" ? forwardTitle(message.text) : message.text;

  const reply = (message.reply as { preview?: string; senderName?: string | null; localId?: string } | null) ?? null;

  return {
    seq: message.seq,
    id: message.id,
    conversationId: message.conversationId,
    scope: message.scope,
    direction: message.direction,
    senderName: message.senderName,
    msgType: message.msgType,
    text,
    status: message.status,
    createdAt: message.createdAt,
    replyPreview: reply?.preview ?? null,
    replyId: reply?.localId ?? null,
    replySender: reply?.senderName ?? null,
    attachments,
  };
}

export async function listWatchConversations(userId: string): Promise<WatchConversation[]> {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(100);
  return rows.map((c) => ({
    id: c.id,
    scope: c.scope,
    peerId: c.peerId,
    title: c.remark || c.title || c.peerId,
    unread: c.unread,
    lastPreview: c.lastPreview,
    lastMessageAt: c.lastMessageAt,
  }));
}

/** 拉取某会话中 seq > afterSeq 的消息（升序），用于手表轮询实时刷新。
 *
 * vc21 重大修复：afterSeq<=0（首载/校准）必须取**最新** limit 条。
 * 旧实现 `ORDER BY seq ASC LIMIT n` 取的是**最旧的** n 条——服务端自动清理
 * 使会话恒有 N 条（默认 32），消息总数一旦超过 limit，聊天页首载永远漏掉
 * 最新几条，且「home 列表有红点、点进聊天看不到/之前收发的消息消失」
 * （首载还会覆盖客户端已显示的新消息）。表现为用户实测：列表缩略字正常、
 * 聊天页内消息消失。afterSeq>0 保持 ASC 游标消费语义（顺序消费不跳消息）。
 */
export async function listWatchMessages(
  userId: string,
  conversationId: string,
  afterSeq: number,
  limit: number,
): Promise<WatchMessage[]> {
  const where = and(
    eq(messages.userId, userId),
    eq(messages.conversationId, conversationId),
    gt(messages.seq, afterSeq),
  );
  if (afterSeq > 0) {
    // 增量轮询：游标之后顺序消费（最旧的先回），绝不跳消息。
    const rows = await db.select().from(messages).where(where).orderBy(asc(messages.seq)).limit(limit);
    return rows.map(watchMessageJson);
  }
  // 首载/校准（after=0）：先 DESC 取最新 limit 条，再反转为升序返回。
  const rows = await db.select().from(messages).where(where).orderBy(desc(messages.seq)).limit(limit);
  rows.reverse();
  return rows.map(watchMessageJson);
}

/**
 * bug#20：跨会话全局增量 —— seq 是全表主键 identity（全局单调递增），
 * 因此首页可以用一个全局 seq 游标一次拉取**所有会话**的新消息，
 * 供「每 3 秒把所有聊天的消息一起同步」的全局轮询使用（按 afterSeq=0
 * 调用时路由层会改为返回 serverMaxSeq 以初始化游标，避免首拉全库）。
 */
export async function listWatchMessagesSince(
  userId: string,
  afterSeq: number,
  limit: number,
): Promise<WatchMessage[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), gt(messages.seq, afterSeq)))
    .orderBy(asc(messages.seq))
    .limit(limit);
  return rows.map(watchMessageJson);
}

/** 当前用户全表最大 seq（游标初始化用；无消息返回 0）。 */
export async function maxWatchSeq(userId: string): Promise<number> {
  const rows = await db
    .select({ v: sql<number>`coalesce(max(${messages.seq}), 0)` })
    .from(messages)
    .where(eq(messages.userId, userId));
  return Number(rows[0]?.v || 0);
}


/**
 * 等待指定会话出现新消息或新状态变化。手表不能使用 WebSocket/SSE，因此这里
 * 把服务器端 EventEmitter 转换成一次性的 HTTP 长轮询：有事件立即返回，无事件
 * 最多等待 boundedWait（默认 20 秒）。客户端空闲期固定歇 3.1 秒再发起下一次，
 * 符合手表框架「轮询间隔 ≥3s」限制，同时比固定 3 秒轮询更省电、更接近实时。
 *
 * 双保险设计（缺一不可）：
 *  1. 事件唤醒 —— QQ 网关消息落库后 bus.emit，等待中的请求立刻返回（<1s，主路径）；
 *  2. 周期复查 —— 每 RE_CHECK_MS 主动查一次库。万一 bus 事件丢失（多进程部署、
 *     服务重启、非网关路径入库等），消息仍能在 RE_CHECK_MS 内到达，
 *     而不是死等到 20 秒超时才返回。
 * 对手表而言始终只有「一个」在途请求，不会违反 ≥3s 的轮询间隔限制。
 *
 * vc19（实时性极致优化）：
 *  - 返回值从 WatchMessage[] 改为 { messages, touched }。touched 表示 hold 期间
 *    该会话发生过 message 事件（含撤回/发送状态等 seq 不变的更新）。
 *  - 唤醒条件放宽：同会话 message 事件无论 seq 是否推进都唤醒（旧逻辑
 *    `seq <= afterSeq` 直接忽略，导致「撤回」要等下一轮 3.1s 轮询的 sync
 *    才可见，最坏 12s hold + 3.1s ≈ 15s）。唤醒后无新消息时 messages 为空、
 *    touched=true，客户端据此快速续拉一轮（带 sync 参数），撤回/状态可见性
 *    从最坏 ~15s 提速到 ~0.3s+RTT。
 */
const RE_CHECK_MS = 1_500;

export async function waitForWatchMessages(
  userId: string,
  conversationId: string,
  afterSeq: number,
  limit: number,
  waitMs = 20_000,
): Promise<{ messages: WatchMessage[]; touched: boolean }> {
  const boundedWait = Math.min(Math.max(waitMs, 3_000), 20_000);
  return new Promise<{ messages: WatchMessage[]; touched: boolean }>((resolve) => {
    let done = false;
    let touched = false;
    let deadlineTimer: NodeJS.Timeout | null = null;
    let reCheckTimer: NodeJS.Timeout | null = null;
    let unsubscribe: (() => void) | null = null;

    const cleanup = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (reCheckTimer) clearTimeout(reCheckTimer);
      if (unsubscribe) unsubscribe();
      deadlineTimer = null;
      reCheckTimer = null;
      unsubscribe = null;
    };

    const finish = async () => {
      if (done) return;
      done = true;
      cleanup();
      try {
        resolve({ messages: await listWatchMessages(userId, conversationId, afterSeq, limit), touched });
      } catch {
        resolve({ messages: [], touched });
      }
    };

    unsubscribe = bus.subscribe((event) => {
      if (event.userId !== userId || event.type !== "message") return;
      const data = event.data as { message?: { conversationId?: string; seq?: number } } | null;
      if (data?.message?.conversationId !== conversationId) return;
      // vc19：同会话状态变化（撤回等，seq 不推进）也标记 touched 并唤醒；
      // 消息事件照常唤醒。唤醒后由 finish 查库决定返回内容。
      touched = true;
      void finish();
    });

    deadlineTimer = setTimeout(() => { void finish(); }, boundedWait);

    // 周期复查：兜住「bus 事件丢失」的情况。
    const scheduleReCheck = () => {
      if (done) return;
      reCheckTimer = setTimeout(() => {
        if (done) return;
        void listWatchMessages(userId, conversationId, afterSeq, limit)
          .then((rows) => {
            if (done) return;
            if (rows.length > 0) {
              done = true;
              cleanup();
              resolve({ messages: rows, touched });
              return;
            }
            scheduleReCheck();
          })
          .catch(() => { if (!done) scheduleReCheck(); });
      }, RE_CHECK_MS);
    };
    scheduleReCheck();

    // 订阅后再查一次，消除“查询完成到订阅建立之间”丢事件的竞态。
    void listWatchMessages(userId, conversationId, afterSeq, limit).then((rows) => {
      if (rows.length > 0) {
        done = true;
        cleanup();
        resolve({ messages: rows, touched });
      }
    }).catch(() => {});
  });
}

export async function markWatchRead(userId: string, conversationId: string): Promise<void> {
  await markRead(userId, conversationId);
}
