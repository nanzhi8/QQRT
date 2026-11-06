import type { InferSelectModel } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * 数据模型
 *
 * 多用户设计：每个网页账号 (users) 绑定自己的 QQ 机器人，所有业务表都带
 * user_id，浏览器之间通过独立的 session cookie 隔离，绝不串账号。
 */

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull(),
  userAgent: text("user_agent"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

/** 每个用户的键值设置：机器人凭证（加密）、常驻接收开关、机器人资料等。 */
export const settings = pgTable(
  "settings",
  {
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** 会话（私聊 / 群聊）列表。 */
export const conversations = pgTable(
  "conversations",
  {
    userId: text("user_id").notNull(),
    id: text("id").notNull(), // `${scope}:${peerId}`
    scope: text("scope").notNull(), // c2c | group
    peerId: text("peer_id").notNull(),
    title: text("title").notNull(),
    avatar: text("avatar"),
    remark: text("remark"), // 用户自定义备注名，优先级最高
    lastMessageAt: bigint("last_message_at", { mode: "number" }).notNull().default(0),
    lastPreview: text("last_preview").notNull().default(""),
    unread: integer("unread").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] }), index("conv_user_time_idx").on(t.userId, t.lastMessageAt)],
);

export interface AttachmentMeta {
  url?: string;
  localId?: string;
  contentType: string;
  filename?: string;
  size?: number;
  width?: number;
  height?: number;
  /** 音/视频时长（秒），用于手表端进度显示。 */
  duration?: number;
  voiceWavUrl?: string;
  asrText?: string;
}

export interface ReplyRef {
  /** 被引用消息的平台 msg_id（用于定位/滚动）。 */
  qqMsgId?: string | null;
  /** 本地消息 id。 */
  localId?: string;
  preview: string;
  senderName?: string | null;
}

export const messages = pgTable(
  "messages",
  {
    seq: bigint("seq", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    id: text("id").notNull().unique(),
    userId: text("user_id").notNull(),
    qqMessageId: text("qq_message_id"),
    referenceIdx: text("reference_idx"),
    conversationId: text("conversation_id").notNull(),
    scope: text("scope").notNull(),
    peerId: text("peer_id").notNull(),
    direction: text("direction").notNull(), // in | out
    senderId: text("sender_id"),
    senderName: text("sender_name"),
    msgType: text("msg_type").notNull(), // text | image | video | voice | file | system
    text: text("text"),
    attachments: jsonb("attachments").$type<AttachmentMeta[]>().notNull().default([]),
    status: text("status").notNull().default("sent"), // sending | sent | failed | recalled
    error: text("error"),
    reply: jsonb("reply").$type<ReplyRef | null>(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("msg_conv_idx").on(t.userId, t.conversationId, t.seq),
    uniqueIndex("msg_qq_idx").on(t.userId, t.qqMessageId),
  ],
);

/** 名称 / 头像缓存（群、群成员、私聊用户），修复名称显示问题。 */
export const contacts = pgTable(
  "contacts",
  {
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(), // group | member | user
    openid: text("openid").notNull(),
    name: text("name"),
    avatar: text("avatar"),
    extra: jsonb("extra").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.openid] })],
);

export const friendEvents = pgTable(
  "friend_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    openid: text("openid").notNull(),
    scene: text("scene"),
    shortCode: text("short_code"),
    eventTime: bigint("event_time", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("friend_ev_idx").on(t.userId, t.openid)],
);

export const groupRobotEvents = pgTable(
  "group_robot_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    eventType: text("event_type").notNull(), // add | del
    groupOpenid: text("group_openid").notNull(),
    opMemberOpenid: text("op_member_openid"),
    eventTime: bigint("event_time", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("group_robot_ev_idx").on(t.userId, t.createdAt)],
);

export const joinRequests = pgTable(
  "join_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    joinRequestId: text("join_request_id"),
    groupOpenid: text("group_openid").notNull(),
    memberOpenid: text("member_openid").notNull(),
    username: text("username"),
    applyAt: text("apply_at"),
    applySource: text("apply_source"),
    invitedBy: text("invited_by"),
    verifyInfo: jsonb("verify_info").$type<Record<string, unknown>>(),
    riskTips: text("risk_tips"),
    status: text("status").notNull().default("pending"), // pending | approved | declined
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    processedAt: bigint("processed_at", { mode: "number" }),
  },
  (t) => [uniqueIndex("join_req_idx").on(t.userId, t.joinRequestId), index("join_req_user_idx").on(t.userId, t.createdAt)],
);

export type User = InferSelectModel<typeof users>;
export type SessionRow = InferSelectModel<typeof sessions>;
export type ConversationRow = InferSelectModel<typeof conversations>;
export type MessageRow = InferSelectModel<typeof messages>;
export type ContactRow = InferSelectModel<typeof contacts>;
export type FriendEventRow = InferSelectModel<typeof friendEvents>;
export type GroupRobotEventRow = InferSelectModel<typeof groupRobotEvents>;
export type JoinRequestRow = InferSelectModel<typeof joinRequests>;
