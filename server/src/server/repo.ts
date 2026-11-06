import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  contacts,
  conversations,
  friendEvents,
  groupRobotEvents,
  joinRequests,
  messages,
  sessions,
  settings,
  users,
  type AttachmentMeta,
  type ContactRow,
  type ConversationRow,
  type JoinRequestRow,
  type MessageRow,
  type ReplyRef,
} from "@/db/schema";
import { newId } from "@/lib/auth";
import { log } from "@/lib/logger";

/**
 * bug#5：自动清理设置的进程内缓存（带 TTL）。
 *
 * 原实现每条消息落库都会走 pruneConversationMessages，而 prune 第一步就是
 * getTrimSetting → 2 次 settings 查询。群聊刷屏时这是每条消息 2 次多余的
 * 数据库往返。设置本身极少变化，故缓存 30 秒；任何 setSetting 写入都会
 * 立即失效该用户缓存（见 setSetting），保证「改了设置马上生效」不丢。
 */
const TRIM_CACHE_TTL_MS = 30_000;
const trimCache = new Map<string, { at: number; value: { on: boolean; n: number } }>();

export type Scope = "c2c" | "group";

export function convId(scope: Scope, peerId: string): string {
  return `${scope}:${peerId}`;
}

export function parseConversationId(id: string): { scope: Scope; peerId: string } | null {
  const idx = id.indexOf(":");
  if (idx <= 0) return null;
  const scope = id.slice(0, idx);
  if (scope !== "c2c" && scope !== "group") return null;
  return { scope: scope as Scope, peerId: id.slice(idx + 1) };
}

// ── settings ───────────────────────────────────────────────────────────────

export async function getSetting(userId: string, key: string): Promise<string | null> {
  const rows = await db.select().from(settings).where(and(eq(settings.userId, userId), eq(settings.key, key))).limit(1);
  return rows[0]?.value ?? null;
}

export async function setSetting(userId: string, key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ userId, key, value })
    .onConflictDoUpdate({ target: [settings.userId, settings.key], set: { value } });
  // bug#5：设置是热路径缓存（见 getTrimSetting），写入后必须立即失效，保证
  // 「用户改了自动清理设置 → 下一条消息立刻按新设置处理」，不会读到旧缓存。
  trimCache.delete(userId);
}

export async function delSetting(userId: string, key: string): Promise<void> {
  await db.delete(settings).where(and(eq(settings.userId, userId), eq(settings.key, key)));
}

export async function listUsersWithSetting(key: string): Promise<string[]> {
  const rows = await db.select({ userId: settings.userId }).from(settings).where(eq(settings.key, key));
  return [...new Set(rows.map((r) => r.userId))];
}

// ── conversations ──────────────────────────────────────────────────────────

export async function getConversation(userId: string, id: string): Promise<ConversationRow | null> {
  const rows = await db.select().from(conversations).where(and(eq(conversations.userId, userId), eq(conversations.id, id))).limit(1);
  return rows[0] ?? null;
}

export async function listConversations(userId: string): Promise<ConversationRow[]> {
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.unread));
}

export interface UpsertConversationInput {
  id: string;
  scope: Scope;
  peerId: string;
  title?: string;
  avatar?: string | null;
  lastMessageAt?: number;
  lastPreview?: string;
}

/** 会话不存在则创建；已存在只补齐标题/头像（不覆盖更新时间与预览）。 */
export async function ensureConversation(userId: string, input: UpsertConversationInput): Promise<ConversationRow> {
  await db
    .insert(conversations)
    .values({
      userId,
      id: input.id,
      scope: input.scope,
      peerId: input.peerId,
      title: input.title ?? input.peerId,
      avatar: input.avatar ?? null,
      lastMessageAt: input.lastMessageAt ?? 0,
      lastPreview: input.lastPreview ?? "",
      unread: 0,
    })
    .onConflictDoUpdate({
      target: [conversations.userId, conversations.id],
      set: {
        title: sql`CASE WHEN ${conversations.title} = ${conversations.peerId} AND EXCLUDED.title <> EXCLUDED.peer_id THEN EXCLUDED.title ELSE ${conversations.title} END`,
        avatar: sql`COALESCE(EXCLUDED.avatar, ${conversations.avatar})`,
      },
    });
  const conv = await getConversation(userId, input.id);
  return conv!;
}

/** 收到/发送消息时更新会话（时间、预览、未读）。 */
export async function touchConversation(
  userId: string,
  id: string,
  opts: { lastMessageAt: number; lastPreview: string; incrUnread?: boolean },
): Promise<ConversationRow | null> {
  await db
    .update(conversations)
    .set({
      lastMessageAt: opts.lastMessageAt,
      lastPreview: opts.lastPreview,
      unread: opts.incrUnread ? sql`${conversations.unread} + 1` : conversations.unread,
    })
    .where(and(eq(conversations.userId, userId), eq(conversations.id, id)));
  return getConversation(userId, id);
}

export async function updateConversationIdentity(
  userId: string,
  id: string,
  patch: { title?: string; avatar?: string | null },
): Promise<ConversationRow | null> {
  const set: { title?: string; avatar?: string | null } = {};
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.avatar !== undefined) set.avatar = patch.avatar;
  if (Object.keys(set).length === 0) return getConversation(userId, id);
  await db.update(conversations).set(set).where(and(eq(conversations.userId, userId), eq(conversations.id, id)));
  return getConversation(userId, id);
}

export async function setConversationRemark(userId: string, id: string, remark: string | null): Promise<ConversationRow | null> {
  await db.update(conversations).set({ remark }).where(and(eq(conversations.userId, userId), eq(conversations.id, id)));
  return getConversation(userId, id);
}

export async function markRead(userId: string, id: string): Promise<void> {
  await db.update(conversations).set({ unread: 0 }).where(and(eq(conversations.userId, userId), eq(conversations.id, id)));
}

// ── messages ───────────────────────────────────────────────────────────────

export interface InsertMessageInput {
  id?: string;
  userId: string;
  qqMessageId?: string | null;
  referenceIdx?: string | null;
  conversationId: string;
  scope: Scope;
  peerId: string;
  direction: "in" | "out";
  senderId?: string | null;
  senderName?: string | null;
  msgType: string;
  text?: string | null;
  attachments?: AttachmentMeta[];
  status?: string;
  error?: string | null;
  reply?: ReplyRef | null;
  createdAt: number;
}

/** 插入消息；若 qq_message_id 重复返回已有记录（幂等，绝不重复入库）。 */
export async function insertMessage(input: InsertMessageInput): Promise<{ row: MessageRow; duplicate: boolean }> {
  const id = input.id ?? newId();
  try {
    const rows = await db
      .insert(messages)
      .values({
        id,
        userId: input.userId,
        qqMessageId: input.qqMessageId ?? null,
        referenceIdx: input.referenceIdx ?? null,
        conversationId: input.conversationId,
        scope: input.scope,
        peerId: input.peerId,
        direction: input.direction,
        senderId: input.senderId ?? null,
        senderName: input.senderName ?? null,
        msgType: input.msgType,
        text: input.text ?? null,
        attachments: input.attachments ?? [],
        status: input.status ?? "sent",
        error: input.error ?? null,
        reply: input.reply ?? null,
        createdAt: input.createdAt,
      })
      .returning();
    await pruneConversationMessages(input.userId, input.conversationId);
    return { row: rows[0], duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err) && input.qqMessageId) {
      const existing = await findMessageByQQId(input.userId, input.qqMessageId);
      if (existing) {
        await pruneConversationMessages(input.userId, input.conversationId);
        return { row: existing, duplicate: true };
      }
    }
    throw err;
  }
}

/** 自动清理设置：开关（默认开）+ 保留条数（默认 32）。 */
export const TRIM_SETTING_KEY = "trim_on";
export const TRIM_COUNT_KEY = "trim_n";
export const TRIM_DEFAULT_ON = true;
export const TRIM_DEFAULT_N = 32;
export const TRIM_MAX_N = 200;
export const TRIM_MIN_N = 10;

export interface TrimSetting {
  on: boolean;
  n: number;
}

/**
 * 读取某个用户的自动清理设置。
 *
 * bug#7：此前服务端在每条消息落库后**无条件**裁剪到 32 条，导致手表端把
 * 「消息自动清理」关掉也没用（旧消息照样被服务端删掉）。现在裁剪策略由用户
 * 设置驱动：开关关闭时**完全不裁剪**，开启时按用户设定的条数裁剪。
 */
export async function getTrimSetting(userId: string): Promise<TrimSetting> {
  const hit = trimCache.get(userId);
  if (hit && Date.now() - hit.at < TRIM_CACHE_TTL_MS) return hit.value;
  try {
    const [onRaw, nRaw] = await Promise.all([getSetting(userId, TRIM_SETTING_KEY), getSetting(userId, TRIM_COUNT_KEY)]);
    const on = onRaw === null ? TRIM_DEFAULT_ON : onRaw !== "0";
    const parsed = Number(nRaw);
    const n = Number.isFinite(parsed) && parsed > 0 ? Math.min(TRIM_MAX_N, Math.max(TRIM_MIN_N, Math.floor(parsed))) : TRIM_DEFAULT_N;
    const value = { on, n };
    trimCache.set(userId, { at: Date.now(), value });
    return value;
  } catch (e) {
    log.warn("getTrimSetting failed, fallback to default", e);
    return { on: TRIM_DEFAULT_ON, n: TRIM_DEFAULT_N };
  }
}

const PRUNE_HARD_CAP = 5000; // 关闭自动清理时的安全上限，防止单会话无限膨胀撑爆手表/磁盘

/**
 * bug#5：裁剪的「摊还」节流。
 *
 * 逐条裁剪的代价与 `limit` 成正比：开启自动清理时 limit 很小（默认 32，最多
 * 200），SELECT 32 行 + DELETE 只在超过时发生，本身很便宜；但**关闭**自动清理
 * 时 limit 是硬上限 5000 —— 每条消息都 SELECT 5000 行 id 是实打实的浪费。
 *
 * 因此：仅在「关闭清理」这条路径上做摊还（每 K 条执行一次硬上限检查），
 * 开启清理时仍逐条裁剪（行为与 bug#7 的预期完全一致：落库即裁剪到 N）。
 * 配合上方 getTrimSetting 的进程内缓存，开启路径每条消息已几乎无额外查询。
 */
const AMORTIZED_HARD_CAP_EVERY = 16;
const hardCapCounter = new Map<string, number>();

async function pruneConversationMessages(userId: string, conversationId: string): Promise<void> {
  try {
    const { on, n } = await getTrimSetting(userId);
    const limit = on ? n : PRUNE_HARD_CAP;

    if (!on) {
      // 关闭清理：只做摊还的硬上限保护（非用户可见行为，纯防爆）。
      const key = `${userId}\u0000${conversationId}`;
      const next = (hardCapCounter.get(key) ?? 0) + 1;
      if (next < AMORTIZED_HARD_CAP_EVERY) {
        hardCapCounter.set(key, next);
        return;
      }
      hardCapCounter.set(key, 0);
    }

    const keep = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.conversationId, conversationId)))
      .orderBy(desc(messages.seq))
      .limit(limit);
    if (keep.length < limit) return;
    const keepIds = keep.map((m) => m.id);
    await db
      .delete(messages)
      .where(
        and(
          eq(messages.userId, userId),
          eq(messages.conversationId, conversationId),
          notInArray(messages.id, keepIds),
        ),
      );
  } catch (e) {
    log.warn("pruneConversationMessages failed", e);
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505";
}

export async function findMessageByQQId(userId: string, qqMessageId: string): Promise<MessageRow | null> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.qqMessageId, qqMessageId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getMessage(userId: string, id: string): Promise<MessageRow | null> {
  const rows = await db.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.id, id))).limit(1);
  return rows[0] ?? null;
}

/** 批量按 id 取消息（限制 id 数量，防止 URL 参数过大）。 */
export async function getMessagesByIds(userId: string, ids: string[]): Promise<MessageRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), inArray(messages.id, ids)))
    .limit(ids.length);
}

/** 根据出站附件的 localId 找到原消息，用于本地文件下载时还原文件名/类型。 */
export async function findOutboundByLocalId(
  userId: string,
  localId: string,
): Promise<{ message: MessageRow; attachment: AttachmentMeta } | null> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.userId, userId),
        eq(messages.direction, "out"),
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${messages.attachments}) a WHERE a->>'localId' = ${localId})`,
      ),
    )
    .limit(1);
  const message = rows[0];
  if (!message) return null;
  const attachment = (message.attachments as AttachmentMeta[]).find((a) => a.localId === localId);
  if (!attachment) return null;
  return { message, attachment };
}

export async function listMessages(
  userId: string,
  conversationId: string,
  limit: number,
  beforeSeq?: number,
): Promise<{ rows: MessageRow[]; hasMore: boolean }> {
  const conds = [eq(messages.userId, userId), eq(messages.conversationId, conversationId)];
  if (beforeSeq) conds.push(lt(messages.seq, beforeSeq));
  const rows = await db
    .select()
    .from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.seq))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit).reverse(), hasMore };
}

/** 会话内附件消息（用于“群文件/聊天文件”抽屉，包含图片、视频、语音和普通文件）。 */
export async function listFileMessages(
  userId: string,
  conversationId: string,
  limit = 100,
): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.userId, userId),
        eq(messages.conversationId, conversationId),
        inArray(messages.msgType, ["image", "video", "voice", "file"]),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(limit);
}

/** 删除单个会话的全部消息，并返回被删除的消息（用于清理对应媒体缓存）。 */
export async function deleteConversationMessages(userId: string, conversationId: string): Promise<MessageRow[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.conversationId, conversationId)));
  await db
    .delete(messages)
    .where(and(eq(messages.userId, userId), eq(messages.conversationId, conversationId)));
  return rows;
}

/** 删除单条消息记录。 */
export async function deleteMessageById(userId: string, id: string): Promise<MessageRow | null> {
  const rows = await db.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.id, id))).limit(1);
  if (!rows[0]) return null;
  await db.delete(messages).where(and(eq(messages.userId, userId), eq(messages.id, id)));
  return rows[0];
}

/** 删除消息后，把会话的最近预览回退到下一条最新消息。 */
export async function refreshConversationPreview(userId: string, conversationId: string): Promise<void> {
  const latest = await db
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.conversationId, conversationId)))
    .orderBy(desc(messages.seq))
    .limit(1);
  const preview = latest[0] ? latest[0].text?.trim() || `[${latest[0].msgType}]` : "";
  await db
    .update(conversations)
    .set({ lastPreview: preview, lastMessageAt: latest[0]?.createdAt ?? 0 })
    .where(and(eq(conversations.userId, userId), eq(conversations.id, conversationId)));
}

/** 彻底删除一个会话及其全部消息（用于退出的群聊/删除的好友）。 */
export async function deleteConversation(userId: string, conversationId: string): Promise<MessageRow[]> {
  const rows = await deleteConversationMessages(userId, conversationId);
  await db.delete(conversations).where(and(eq(conversations.userId, userId), eq(conversations.id, conversationId)));
  return rows;
}

/** 删除该账号的全部消息，并返回被删除的消息（用于清理全部聊天缓存）。 */
export async function deleteAllMessages(userId: string): Promise<MessageRow[]> {
  const rows = await db.select().from(messages).where(eq(messages.userId, userId));
  await db.delete(messages).where(eq(messages.userId, userId));
  return rows;
}

export async function resetConversationsAfterClear(userId: string, conversationId?: string): Promise<void> {
  if (conversationId) {
    await db
      .update(conversations)
      .set({ lastMessageAt: 0, lastPreview: "", unread: 0 })
      .where(and(eq(conversations.userId, userId), eq(conversations.id, conversationId)));
  } else {
    await db
      .update(conversations)
      .set({ lastMessageAt: 0, lastPreview: "", unread: 0 })
      .where(eq(conversations.userId, userId));
  }
}

export async function updateMessageStatus(userId: string, id: string, status: string, error?: string | null): Promise<MessageRow | null> {
  await db
    .update(messages)
    .set({ status, error: error === undefined ? messages.error : error })
    .where(and(eq(messages.userId, userId), eq(messages.id, id)));
  return getMessage(userId, id);
}

/** 回填图片附件的宽高（入站时 QQ 不给尺寸，异步探测后补上） */
export async function updateMessageAttachmentDims(
  userId: string,
  id: string,
  index: number,
  width: number,
  height: number,
): Promise<MessageRow | null> {
  const row = await getMessage(userId, id);
  if (!row) return null;
  const list = (row.attachments as AttachmentMeta[] | null) ?? [];
  const att = list[index];
  if (!att) return null;
  if (att.width && att.height) return row;
  const next = list.map((a, i) => (i === index ? { ...a, width, height } : a));
  await db
    .update(messages)
    .set({ attachments: next })
    .where(and(eq(messages.userId, userId), eq(messages.id, id)));
  return { ...row, attachments: next };
}

export async function setMessageQQId(userId: string, id: string, qqMessageId: string): Promise<void> {
  await db.update(messages).set({ qqMessageId }).where(and(eq(messages.userId, userId), eq(messages.id, id), isNull(messages.qqMessageId)));
}

/** 保存消息的 QQ 引用索引（发消息后平台返回的 ref_idx / 入站消息的 msg_idx）。 */
export async function setMessageReferenceIdx(userId: string, id: string, referenceIdx: string): Promise<void> {
  await db
    .update(messages)
    .set({ referenceIdx })
    .where(and(eq(messages.userId, userId), eq(messages.id, id), isNull(messages.referenceIdx)));
}

// ── contacts (名称/头像缓存) ─────────────────────────────────────────────

export async function getContact(userId: string, kind: string, openid: string): Promise<ContactRow | null> {
  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.kind, kind), eq(contacts.openid, openid)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertContact(
  userId: string,
  kind: string,
  openid: string,
  patch: { name?: string | null; avatar?: string | null; extra?: Record<string, unknown> },
): Promise<ContactRow> {
  await db
    .insert(contacts)
    .values({
      userId,
      kind,
      openid,
      name: patch.name ?? null,
      avatar: patch.avatar ?? null,
      extra: patch.extra ?? {},
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [contacts.userId, contacts.kind, contacts.openid],
      set: {
        name: sql`COALESCE(EXCLUDED.name, ${contacts.name})`,
        avatar: sql`COALESCE(EXCLUDED.avatar, ${contacts.avatar})`,
        extra: sql`COALESCE(EXCLUDED.extra, ${contacts.extra})`,
        updatedAt: Date.now(),
      },
    });
  return (await getContact(userId, kind, openid))!;
}

export async function listGroupContacts(userId: string): Promise<ContactRow[]> {
  return db.select().from(contacts).where(and(eq(contacts.userId, userId), eq(contacts.kind, "group"))).orderBy(asc(contacts.name));
}

/** 当前账号已缓存的群成员（用于接口无权限时兜底展示，也用于 @ 成员）。 */
export async function listMemberContacts(userId: string): Promise<ContactRow[]> {
  return db
    .select()
    .from(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.kind, "member")))
    .orderBy(desc(contacts.updatedAt), asc(contacts.name));
}

/** 某群真正出现过的发送者（从该群入站消息里按发送者去重）。 */
export async function listInboundGroupSenders(userId: string, groupOpenid: string): Promise<Array<{ senderId: string; senderName: string | null }>> {
  const rows = await db
    .selectDistinct({
      senderId: messages.senderId,
      senderName: messages.senderName,
    })
    .from(messages)
    .where(
      and(
        eq(messages.userId, userId),
        eq(messages.scope, "group"),
        eq(messages.peerId, groupOpenid),
        eq(messages.direction, "in"),
        isNotNull(messages.senderId),
      ),
    )
    .limit(500);

  const byId = new Map<string, { senderId: string; senderName: string | null }>();
  for (const row of rows) {
    if (!row.senderId) continue;
    const existing = byId.get(row.senderId);
    if (!existing || (row.senderName && !existing.senderName)) {
      byId.set(row.senderId, { senderId: row.senderId, senderName: row.senderName ?? existing?.senderName ?? null });
    }
  }
  return [...byId.values()];
}

/** 查找某条引用事件之前、尚未保存 QQ 引用索引的本地消息，供 ref_msg_idx 回填。 */
export async function listUnreferencedMessageCandidates(
  userId: string,
  conversationId: string,
  beforeSeq: number,
  limit = 120,
): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.userId, userId),
        eq(messages.conversationId, conversationId),
        isNull(messages.referenceIdx),
        lt(messages.seq, beforeSeq),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(limit);
}

// ── friend / group robot events / join requests ───────────────────────────

export async function insertFriendEvent(userId: string, openid: string, scene: string | null, shortCode: string | null, eventTime: number) {
  try {
    const rows = await db
      .insert(friendEvents)
      .values({ id: newId(), userId, openid, scene, shortCode, eventTime, createdAt: Date.now() })
      .returning();
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) return null; // 幂等
    throw err;
  }
}

export async function listFriendEvents(userId: string) {
  return db.select().from(friendEvents).where(eq(friendEvents.userId, userId)).orderBy(desc(friendEvents.createdAt)).limit(100);
}

export async function insertGroupRobotEvent(
  userId: string,
  eventType: string,
  groupOpenid: string,
  opMemberOpenid: string | null,
  eventTime: number,
) {
  const dup = await db
    .select()
    .from(groupRobotEvents)
    .where(
      and(
        eq(groupRobotEvents.userId, userId),
        eq(groupRobotEvents.eventType, eventType),
        eq(groupRobotEvents.groupOpenid, groupOpenid),
        opMemberOpenid ? eq(groupRobotEvents.opMemberOpenid, opMemberOpenid) : isNull(groupRobotEvents.opMemberOpenid),
        eq(groupRobotEvents.eventTime, eventTime),
      ),
    )
    .limit(1);
  if (dup.length > 0) return dup[0];
  const rows = await db
    .insert(groupRobotEvents)
    .values({ id: newId(), userId, eventType, groupOpenid, opMemberOpenid, eventTime, createdAt: Date.now() })
    .returning();
  return rows[0];
}

export async function listGroupRobotEvents(userId: string) {
  return db.select().from(groupRobotEvents).where(eq(groupRobotEvents.userId, userId)).orderBy(desc(groupRobotEvents.createdAt)).limit(100);
}

export async function insertJoinRequest(
  userId: string,
  input: {
    joinRequestId: string | null;
    groupOpenid: string;
    memberOpenid: string;
    username: string | null;
    applyAt: string | null;
    applySource: string | null;
    invitedBy: string | null;
    verifyInfo: Record<string, unknown> | null;
    riskTips: string | null;
  },
): Promise<JoinRequestRow | null> {
  if (input.joinRequestId) {
    const dup = await db
      .select()
      .from(joinRequests)
      .where(and(eq(joinRequests.userId, userId), eq(joinRequests.joinRequestId, input.joinRequestId)))
      .limit(1);
    if (dup.length > 0) return null;
  }
  const rows = await db
    .insert(joinRequests)
    .values({ id: newId(), userId, status: "pending", createdAt: Date.now(), ...input })
    .returning();
  return rows[0];
}

export async function getJoinRequest(userId: string, id: string): Promise<JoinRequestRow | null> {
  const rows = await db.select().from(joinRequests).where(and(eq(joinRequests.userId, userId), eq(joinRequests.id, id))).limit(1);
  return rows[0] ?? null;
}

export async function updateJoinRequestStatus(userId: string, id: string, status: string): Promise<JoinRequestRow | null> {
  await db
    .update(joinRequests)
    .set({ status, processedAt: Date.now() })
    .where(and(eq(joinRequests.userId, userId), eq(joinRequests.id, id)));
  return getJoinRequest(userId, id);
}

export async function listJoinRequests(userId: string) {
  return db.select().from(joinRequests).where(eq(joinRequests.userId, userId)).orderBy(desc(joinRequests.createdAt)).limit(100);
}

/** 清理 60 天前的会话外消息，避免无限膨胀（可按需调整）。 */
export async function pruneOldMessages(userId: string): Promise<void> {
  const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
  try {
    await db.delete(messages).where(and(eq(messages.userId, userId), lt(messages.createdAt, cutoff)));
  } catch (e) {
    log.warn("pruneOldMessages failed", e);
  }
}

/** 全部用户的定时清理入口（由 instrumentation 每天调用）。 */
export async function pruneAllUsersOldMessages(): Promise<void> {
  try {
    const rows = await db.select({ id: users.id }).from(users);
    for (const u of rows) {
      await pruneOldMessages(u.id);
    }
    // 顺便清理过期会话（30 天前），防止 sessions 表无限膨胀。
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    try {
      const deleted = await db.delete(sessions).where(lt(sessions.expiresAt, cutoff)).returning();
      if (deleted.length > 0) log.info(`pruned ${deleted.length} expired session(s)`);
    } catch (e) {
      log.debug("session GC failed", e);
    }
    if (rows.length > 0) log.info(`pruned old messages for ${rows.length} user(s)`);
  } catch (e) {
    log.warn("pruneAllUsersOldMessages failed", e);
  }
}
