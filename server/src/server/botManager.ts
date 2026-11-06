import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  FileKVStore,
  MediaFileType,
  MsgType,
  QQBot,
  kvSessionPersistence,
  type QQBotInboundMessage,
  type MessageResponse,
  type ReplyTarget,
  type UploadMediaResponse,
} from "@tencent-connect/qqbot-nodejs";
import { bus } from "@/lib/bus";
import { config, ensureDirs } from "@/lib/config";
import { AppError, appError, classifyError, type QQErrorDetail } from "@/lib/errors";
import { log } from "@/lib/logger";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/secret";
import { outPathFor } from "./media";
import {
  convId,
  delSetting,
  ensureConversation,
  findMessageByQQId,
  getContact,
  getConversation,
  getMessage,
  getSetting,
  insertFriendEvent,
  insertGroupRobotEvent,
  insertJoinRequest,
  insertMessage,
  listConversations,
  listInboundGroupSenders,
  listJoinRequests,
  listUnreferencedMessageCandidates,
  markRead,
  setConversationRemark,
  setMessageQQId,
  setMessageReferenceIdx,
  setSetting,
  touchConversation,
  updateConversationIdentity,
  updateJoinRequestStatus,
  updateMessageStatus,
  updateMessageAttachmentDims,
  upsertContact,
  type Scope,
} from "./repo";
import type { AttachmentMeta, ReplyRef } from "@/db/schema";
import { probeRemoteImageSize } from "./imageDims";
import { handleExtraEvent } from "./events";

const execFileAsync = promisify(execFile);

/**
 * 机器人运行时管理器（每个网页用户一个独立的 QQBot 实例）。
 *
 * - 浏览器连接机器人后，网关长连接常驻服务器进程：即使关闭浏览器，消息也
 *   持续入库；重新打开浏览器即可看到期间的所有消息。
 * - “常驻接收”开关：关闭后断开网关停止接收，开启后重新连接并自动补齐
 *   期间错过的消息（通过消息记录接口同步）。
 * - 所有入站消息先落库再推送浏览器，配合 qq_message_id 唯一索引去重，
 *   保证不漏消息、不重复。
 */

export type BotStatus = "disconnected" | "connecting" | "connected" | "error";

export interface BotInfo {
  id: string;
  username: string;
  avatar?: string;
}

export interface StatusPayload {
  status: BotStatus;
  connected: boolean;
  hasCredentials: boolean;
  receive: boolean;
  appId: string | null;
  bot: BotInfo | null;
  lastError: string | null;
  syncing: boolean;
  lastSyncAt: number | null;
}

interface UserBotState {
  status: BotStatus;
  bot: QQBot | null;
  botInfo: BotInfo | null;
  lastError: string | null;
  lastErrorDetail: QQErrorDetail | null;
  abort: AbortController | null;
  stopped: boolean;
  syncing: boolean;
  retryTimer: NodeJS.Timeout | null;
  retryCount: number;
  /** SDK 日志中捕获的最后一条诊断信息（网关被拒绝等 SDK 只记日志不抛事件的场景）。 */
  sdkDiag: string | null;
  /** 连接过程中捕获到致命诊断时的回调（由 connect 注册）。 */
  onFatal: ((detail: QQErrorDetail) => void) | null;
}

interface ManagerGlobal {
  states: Map<string, UserBotState>;
  booted: boolean;
  inflightNames: Set<string>;
  lastSync: Map<string, number>;
}

const g = globalThis as unknown as { __qqbotManager?: ManagerGlobal };

function mgr(): ManagerGlobal {
  if (!g.__qqbotManager) {
    g.__qqbotManager = { states: new Map(), booted: false, inflightNames: new Set(), lastSync: new Map() };
  }
  return g.__qqbotManager;
}

function getState(userId: string): UserBotState {
  const m = mgr();
  let st = m.states.get(userId);
  if (!st) {
    st = {
      status: "disconnected",
      bot: null,
      botInfo: null,
      lastError: null,
      lastErrorDetail: null,
      abort: null,
      stopped: true,
      syncing: false,
      retryTimer: null,
      retryCount: 0,
      sdkDiag: null,
      onFatal: null,
    };
    m.states.set(userId, st);
  }
  return st;
}

// ── 凭证与状态 ─────────────────────────────────────────────────────────────

async function storedCreds(userId: string): Promise<{ appId: string; secret: string } | null> {
  const raw = await getSetting(userId, "credentials");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { appId: string; secretEnc: string };
    return { appId: parsed.appId, secret: decryptSecret(parsed.secretEnc) };
  } catch {
    return null;
  }
}

export async function statusPayload(userId: string): Promise<StatusPayload> {
  const st = getState(userId);
  const raw = await getSetting(userId, "credentials");
  let appId: string | null = null;
  if (raw) {
    try {
      appId = (JSON.parse(raw) as { appId: string }).appId;
    } catch {
      /* ignore */
    }
  }
  const receiveRaw = await getSetting(userId, "receive");
  const lastSyncRaw = await getSetting(userId, "lastSyncAt");
  // 服务器重启后网关直接 resume 时，内存里的 botInfo 可能尚未就绪；回退到
  // 持久化的机器人资料，避免界面误显示「未连接机器人」。
  let botInfo = st.botInfo;
  if (!botInfo) {
    const saved = await getSetting(userId, "botInfo");
    if (saved) {
      try {
        botInfo = JSON.parse(saved) as BotInfo;
      } catch {
        botInfo = null;
      }
    }
  }
  return {
    status: st.status,
    connected: st.status === "connected",
    hasCredentials: !!raw,
    receive: receiveRaw !== "off",
    appId: appId ? maskSecret(appId, 4) : null,
    bot: botInfo,
    lastError: st.lastError,
    syncing: st.syncing,
    lastSyncAt: lastSyncRaw ? Number(lastSyncRaw) : null,
  };
}

async function emitStatus(userId: string): Promise<void> {
  bus.emit(userId, "status", await statusPayload(userId));
}

export function requireBot(userId: string): QQBot {
  const st = getState(userId);
  if (!st.bot || st.status !== "connected") {
    throw appError("GATEWAY_ERROR", "机器人尚未连接", "请先在设置中连接机器人");
  }
  return st.bot;
}

// ── 连接 / 断开 / 常驻开关 ────────────────────────────────────────────────

/**
 * 只订阅「群聊 + 私聊」事件（1<<25）。
 *
 * 官方 SDK 默认 FULL_INTENTS 会额外请求频道（GUILDS/GUILD_MEMBERS 等）权限，
 * 对于只开通了群聊/私聊能力的机器人，网关会以 4914/4915 直接断开连接。
 * 这里改用最小必要 intent，避免因权限不匹配导致「静默连不上」。
 */
const GROUP_C2C_INTENTS = 1 << 25;
/** 额外事件：1<<24 群成员进出、1<<26 交互回调；需在平台开通对应权限后再打开 */
const EXTRA_INTENTS = process.env.QQRT_EXTRA_EVENTS === "1" ? (1 << 24) | (1 << 26) : 0;
const BOT_INTENTS = GROUP_C2C_INTENTS | EXTRA_INTENTS;

/**
 * SDK 在很多致命场景（机器人未上线/沙箱模式、被平台限制、intent 权限不足）
 * 只向 logger 写日志、不触发 error 事件，导致上层永远停在“连接中”。
 * 这里给 SDK 注入带捕获能力的 logger：捕获 warn/error 日志，识别致命信息并
 * 立即转成可见错误。
 */
function makeBotLogger(userId: string) {
  const tag = `[qq-sdk:${userId.slice(0, 8)}]`;
  return {
    debug: (...a: unknown[]) => log.debug(`${tag} ${a.map(String).join(" ")}`),
    info: (...a: unknown[]) => log.info(`${tag} ${a.map(String).join(" ")}`),
    warn: (...a: unknown[]) => {
      const msg = a.map(String).join(" ");
      log.warn(`${tag} ${msg}`);
      captureSdkDiag(userId, msg);
    },
    error: (...a: unknown[]) => {
      const msg = a.map(String).join(" ");
      log.error(`${tag} ${msg}`);
      captureSdkDiag(userId, msg);
    },
  };
}

/** 把 SDK 的英文诊断映射成中文可读错误（返回 null 表示非致命，仅记录）。 */
function mapSdkFatal(msg: string): QQErrorDetail | null {
  const m = msg.toLowerCase();
  if (m.includes("offline") || m.includes("sandbox")) {
    return {
      source: "app",
      code: 4914,
      type: "PERMISSION_DENIED",
      message: "机器人未上线或处于沙箱模式",
      suggestion: "请到 QQ 开放平台（q.qq.com）完成机器人「发布/上线」，或在沙箱配置中加入测试群与测试成员",
      retryable: false,
      raw: msg,
    };
  }
  if (m.includes("banned")) {
    return {
      source: "app",
      code: 4915,
      type: "PERMISSION_DENIED",
      message: "机器人已被平台限制",
      suggestion: "请联系 QQ 开放平台解除限制",
      retryable: false,
      raw: msg,
    };
  }
  if (m.includes("too many requests")) {
    return {
      source: "app",
      code: "RATE_LIMIT",
      type: "RATE_LIMIT",
      message: "连接请求过于频繁",
      suggestion: "请稍等片刻后再尝试连接",
      retryable: true,
      raw: msg,
    };
  }
  return null;
}

function captureSdkDiag(userId: string, message: string): void {
  const st = getState(userId);
  st.sdkDiag = message;
  const fatal = mapSdkFatal(message);
  if (fatal && st.onFatal) {
    st.onFatal(fatal);
  }
}

export async function connect(userId: string, appIdInput?: string, appSecretInput?: string): Promise<StatusPayload> {
  ensureDirs();
  let appId = appIdInput?.trim();
  let secret = appSecretInput?.trim();

  if (appId || secret) {
    if (!appId) throw appError("INVALID_REQUEST", "请填写 AppID", "AppID 为必填项");
    if (!secret) throw appError("INVALID_REQUEST", "请填写 AppSecret", "AppSecret 为必填项");
  } else {
    const creds = await storedCreds(userId);
    if (!creds) throw appError("INVALID_REQUEST", "尚未配置机器人凭证", "请先填写 AppID 与 AppSecret");
    appId = creds.appId;
    secret = creds.secret;
  }

  await stopBot(userId, false);
  const st = getState(userId);
  st.status = "connecting";
  st.lastError = null;
  st.lastErrorDetail = null;
  st.stopped = false;
  await emitStatus(userId);

  const bot = new QQBot({
    appId: appId!,
    appSecret: secret!,
    accountId: `${userId}:${appId}`,
    markdownSupport: false,
    intents: BOT_INTENTS,
    logger: makeBotLogger(userId),
    sessionPersistence: kvSessionPersistence({
      store: new FileKVStore({ dir: config.gatewayDir, fileName: `gw-${userId.slice(0, 8)}-${appId!.slice(-6)}.json` }),
      accountId: `${userId}:${appId}`,
    }),
  });
  st.bot = bot;
  st.sdkDiag = null;
  const ac = new AbortController();
  st.abort = ac;

  let resolveReady!: () => void;
  let resolveError!: (d: QQErrorDetail) => void;
  const readyPromise = new Promise<void>((res) => (resolveReady = res));
  // 注意：这里必须用 resolve（而非 reject）——错误走 result === "error" 分支，
  // 保证把分类好的 detail 原样抛成 AppError，避免二次分类丢失原始错误信息。
  const errorPromise = new Promise<QQErrorDetail>((res) => (resolveError = res));

  // SDK 日志中捕获到致命诊断（未上线/沙箱/封禁）时，立即转成可见错误。
  st.onFatal = (detail: QQErrorDetail) => {
    if (st.bot !== bot) return;
    st.status = "error";
    st.lastError = detail.message;
    st.lastErrorDetail = detail;
    void emitStatus(userId);
    resolveError(detail);
    scheduleRetry(userId, detail);
  };

  bot.on("ready", () => {
    if (st.bot !== bot) return;
    st.status = "connected";
    st.lastError = null;
    st.retryCount = 0;
    st.onFatal = null;
    resolveReady();
    void (async () => {
      try {
        await setSetting(userId, "credentials", JSON.stringify({ appId: appId!, secretEnc: encryptSecret(secret!) }));
        await setSetting(userId, "receive", "on");
      } catch (e) {
        log.warn("save credentials failed", e);
      }
      const info = await fetchBotInfo(userId, bot);
      if (st.bot === bot && info) st.botInfo = info;
      await emitStatus(userId);
      // 连接成功后立即同步一次，补齐离线期间的消息与群列表。
      void sync(userId, false).catch((e) => log.warn("auto sync failed", e));
    })();
  });

  bot.on("resumed", () => {
    if (st.bot !== bot) return;
    // 网关「断线重连」成功时 SDK 只触发 resumed 而不触发 ready。若不在此处
    // resolveReady，connect() 会一直等到 15s 超时，导致「重新连接 / 服务器重启
    // 自动重连」都要白等十几秒。这里把它与 ready 同等对待。
    st.status = "connected";
    st.lastError = null;
    st.retryCount = 0;
    st.onFatal = null;
    resolveReady();
    void emitStatus(userId);
    // 服务器重启后直接 resume 时，可能还没拉取机器人资料，补拉一次。
    if (!st.botInfo) {
      void fetchBotInfo(userId, bot).then((info) => {
        if (st.bot === bot && info) {
          st.botInfo = info;
          void emitStatus(userId);
        }
      });
    }
    // 与 ready 一样，恢复连接后补一次群列表/入群申请同步。
    void sync(userId, false).catch((e) => log.warn("auto sync failed", e));
  });

  bot.on("error", (err: Error) => {
    if (st.bot !== bot) return;
    const detail = classifyError(err);
    st.status = "error";
    st.lastError = detail.message;
    st.lastErrorDetail = detail;
    void emitStatus(userId);
    resolveError(detail);
    scheduleRetry(userId, detail);
  });

  bot.on("message", (_ctx, msg) => {
    if (st.bot !== bot) return;
    void handleInbound(userId, msg).catch((e) => log.error("inbound handler failed", e));
  });

  bot.on("rawEvent", (ctx) => {
    if (st.bot !== bot) return;
    void handleRawEvent(userId, ctx.eventType, ctx.data).catch((e) => log.error("raw event handler failed", e));
  });

  const startPromise = bot.start(ac.signal).catch((err) => {
    if (st.bot !== bot || st.stopped) return;
    const detail = classifyError(err);
    st.status = "error";
    st.lastError = detail.message;
    st.lastErrorDetail = detail;
    void emitStatus(userId);
    resolveError(detail);
    scheduleRetry(userId, detail);
  });
  void startPromise;

  let timeoutTimer: NodeJS.Timeout | null = null;
  const timeout = new Promise<"timeout">((res) => {
    timeoutTimer = setTimeout(() => res("timeout"), 15000);
  });
  const result = await Promise.race([
    readyPromise.then(() => "ready" as const),
    errorPromise.then(() => "error" as const),
    timeout,
  ]);
  if (timeoutTimer) clearTimeout(timeoutTimer);

  if (result === "ready") {
    log.info(`bot connected (user=${userId.slice(0, 8)}, app=${maskSecret(appId!, 4)})`);
    return statusPayload(userId);
  }
  if (result === "error") {
    const detail = st.lastErrorDetail ?? classifyError(new Error("连接 QQ 机器人失败"));
    throw new AppError(detail);
  }

  // 超时：网关仍在握手（慢网络）或已被拒绝但 SDK 未报错。检查 SDK 诊断信息，
  // 若存在则给出更明确的提示；否则继续以“连接中”返回并让后台重连。
  if (st.sdkDiag) {
    const detail =
      mapSdkFatal(st.sdkDiag) ??
      ({
        source: "app",
        code: "TIMEOUT",
        type: "TIMEOUT",
        message: "连接 QQ 机器人超时",
        suggestion: "请检查服务器网络，或在 QQ 开放平台确认机器人已上线、权限已开通",
        retryable: true,
        raw: st.sdkDiag,
      } satisfies QQErrorDetail);
    st.status = "error";
    st.lastError = detail.message;
    st.lastErrorDetail = detail;
    await emitStatus(userId);
    throw new AppError(detail);
  }

  const timeoutDetail: QQErrorDetail = {
    source: "app",
    code: "TIMEOUT",
    type: "TIMEOUT",
    message: "连接 QQ 机器人超时",
    suggestion: "请检查服务器网络，或在 QQ 开放平台确认机器人已上线、权限已开通",
    retryable: true,
  };
  st.status = "error";
  st.lastError = timeoutDetail.message;
  st.lastErrorDetail = timeoutDetail;
  await emitStatus(userId);
  scheduleRetry(userId, timeoutDetail);
  throw new AppError(timeoutDetail);
}

/** 网关异常后自动重连（认证错误不重试）。 */
function scheduleRetry(userId: string, detail: QQErrorDetail): void {
  const st = getState(userId);
  if (st.stopped || st.retryTimer) return;
  if (detail.type === "AUTH_ERROR" || detail.type === "PERMISSION_DENIED") return;
  if (st.retryCount >= 20) return;
  st.retryCount += 1;
  const delay = Math.min(60000, 5000 * Math.pow(1.6, st.retryCount - 1));
  st.retryTimer = setTimeout(() => {
    st.retryTimer = null;
    const cur = getState(userId);
    if (cur.stopped || cur.status === "connected" || cur.status === "connecting") return;
    log.info(`auto reconnect attempt ${cur.retryCount} (user=${userId.slice(0, 8)})`);
    void connect(userId).catch((e) => log.warn("auto reconnect failed", e));
  }, delay);
  st.retryTimer.unref?.();
}

export async function disconnect(userId: string, opts?: { clearCreds?: boolean; setReceiveOff?: boolean }): Promise<StatusPayload> {
  await stopBot(userId, true);
  if (opts?.clearCreds) {
    await delSetting(userId, "credentials");
  }
  if (opts?.setReceiveOff) {
    await setSetting(userId, "receive", "off");
  }
  return statusPayload(userId);
}

async function stopBot(userId: string, announce: boolean): Promise<void> {
  const st = getState(userId);
  st.stopped = true;
  st.onFatal = null;
  if (st.retryTimer) {
    clearTimeout(st.retryTimer);
    st.retryTimer = null;
  }
  const bot = st.bot;
  const ac = st.abort;
  st.bot = null;
  st.abort = null;
  st.status = "disconnected";
  try {
    ac?.abort();
  } catch {
    /* ignore */
  }
  try {
    bot?.stop();
  } catch {
    /* ignore */
  }
  if (announce) await emitStatus(userId);
}

/** 常驻接收开关：开 = 保持网关连接；关 = 断开网关（不再接收新消息）。 */
export async function setReceive(userId: string, on: boolean): Promise<StatusPayload> {
  await setSetting(userId, "receive", on ? "on" : "off");
  if (on) {
    const creds = await storedCreds(userId);
    if (!creds) throw appError("INVALID_REQUEST", "尚未配置机器人凭证", "请先填写 AppID 与 AppSecret");
    const st = getState(userId);
    if (st.status !== "connected" && st.status !== "connecting") {
      return connect(userId);
    }
  } else {
    await stopBot(userId, true);
  }
  return statusPayload(userId);
}

// ── 服务器启动自举 ────────────────────────────────────────────────────────

export async function bootAll(): Promise<void> {
  const m = mgr();
  if (m.booted) return;
  m.booted = true;
  try {
    const { listUsersWithSetting } = await import("./repo");
    const userIds = await listUsersWithSetting("credentials");
    for (const userId of userIds) {
      const receive = await getSetting(userId, "receive");
      if (receive === "off") continue;
      void connect(userId).catch((e) => log.warn(`boot connect failed (user=${userId.slice(0, 8)})`, e));
    }
    if (userIds.length > 0) log.info(`boot: auto-connecting ${userIds.length} bot(s)`);
  } catch (e) {
    m.booted = false; // 数据库未就绪时允许下次重试
    log.warn("bootAll failed", e);
  }
}

export function ensureBoot(): void {
  void bootAll();
}

// ── 机器人资料 ────────────────────────────────────────────────────────────

async function fetchBotInfo(userId: string, bot: QQBot): Promise<BotInfo | null> {
  try {
    const me = (await bot.api.get("/users/@me")) as { id?: string; username?: string; avatar?: string };
    if (me?.id) {
      const info = { id: me.id, username: me.username ?? me.id, avatar: me.avatar };
      await setSetting(userId, "botInfo", JSON.stringify(info));
      return info;
    }
    return null;
  } catch (e) {
    log.warn("fetchBotInfo failed", e);
    return null;
  }
}

// ── 名称解析（修复乱码 / 不显示名称的核心） ──────────────────────────────

const NAME_TTL = 24 * 3600 * 1000;
const NEG_TTL = 10 * 60 * 1000;

async function resolveGroup(userId: string, bot: QQBot, groupOpenid: string): Promise<{ name: string; avatar: string | null } | null> {
  const key = `g:${userId}:${groupOpenid}`;
  const m = mgr();
  const cached = await getContact(userId, "group", groupOpenid);
  if (cached && cached.name && cached.extra?.negative !== true && Date.now() - cached.updatedAt < NAME_TTL) {
    return { name: cached.name, avatar: cached.avatar };
  }
  if (cached && cached.extra?.negative === true && Date.now() - cached.updatedAt < NEG_TTL) return null;
  if (m.inflightNames.has(key)) return null;
  m.inflightNames.add(key);
  try {
    const info = (await bot.api.get(`/v2/groups/${encodeURIComponent(groupOpenid)}/info`)) as {
      group_name?: string;
      group_avatar?: string;
    };
    if (info?.group_name) {
      await upsertContact(userId, "group", groupOpenid, { name: info.group_name, avatar: info.group_avatar ?? null });
      return { name: info.group_name, avatar: info.group_avatar ?? null };
    }
    throw new Error("empty group_name");
  } catch {
    await upsertContact(userId, "group", groupOpenid, { name: cached?.name ?? null, extra: { negative: true } }).catch(() => {});
    return null;
  } finally {
    m.inflightNames.delete(key);
  }
}

async function resolveMember(
  userId: string,
  bot: QQBot,
  groupOpenid: string,
  memberOpenid: string,
): Promise<{ name: string; avatar: string | null } | null> {
  const key = `m:${userId}:${groupOpenid}:${memberOpenid}`;
  const m = mgr();
  const cached = await getContact(userId, "member", memberOpenid);
  if (cached && cached.name && cached.extra?.negative !== true && Date.now() - cached.updatedAt < NAME_TTL) {
    return { name: cached.name, avatar: cached.avatar };
  }
  if (cached && cached.extra?.negative === true && Date.now() - cached.updatedAt < NEG_TTL) return null;
  if (m.inflightNames.has(key)) return null;
  m.inflightNames.add(key);
  try {
    const info = (await bot.api.get(`/v2/groups/${encodeURIComponent(groupOpenid)}/members/${encodeURIComponent(memberOpenid)}`)) as {
      nick?: string;
      username?: string;
      avatar?: string;
    };
    const name = info?.nick || info?.username;
    if (name) {
      await upsertContact(userId, "member", memberOpenid, { name, avatar: info?.avatar ?? null });
      return { name, avatar: info?.avatar ?? null };
    }
    throw new Error("empty member nick");
  } catch {
    await upsertContact(userId, "member", memberOpenid, { name: cached?.name ?? null, extra: { negative: true } }).catch(() => {});
    return null;
  } finally {
    m.inflightNames.delete(key);
  }
}

/** 群聊显示名：优先用户备注 → 群名缓存 → 平台接口。 */
export async function displayTitleForGroup(userId: string, bot: QQBot | null, groupOpenid: string): Promise<string> {
  const cached = await getContact(userId, "group", groupOpenid);
  if (cached?.name) return cached.name;
  if (bot) {
    const resolved = await resolveGroup(userId, bot, groupOpenid);
    if (resolved) return resolved.name;
  }
  return "QQ 群聊";
}

// ── 入站消息 ──────────────────────────────────────────────────────────────

// bug#20：QQ 官方对图片/文件附件的 content_type 经常返回空或
// application/octet-stream（WS 推送与历史接口都存在），导致两条链路故障：
//   1) detectMsgType 把图片判成 file —— 手表端不按图片渲染；
//   2) 收藏表情接口按 image/ 前缀校验被拒 —— 用户表现为「收藏图片当表情，
//      表情列表不显示」。
// 这里按 filename / url 的扩展名推断真实类型。仅在原值缺失或为
// octet-stream 时生效（可信的原值一律不动）。
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", heic: "image/heic",
  mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", amr: "audio/amr",
  wav: "audio/wav", silk: "audio/silk",
};

function normAttachmentContentType(
  contentType: string | null | undefined,
  filename?: string | null,
  url?: string | null,
): string {
  const ct = (contentType || "").toLowerCase();
  if (ct && ct !== "application/octet-stream") return contentType as string;
  const probe = `${filename || ""} ${url || ""}`;
  const m = probe.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  const ext = m?.[1]?.toLowerCase();
  if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
  return contentType || "application/octet-stream";
}

function detectMsgType(attachments?: AttachmentMeta[]): string {
  if (attachments && attachments.length > 0) {
    const ct = (attachments[0].contentType || "").toLowerCase();
    if (ct.startsWith("image/")) return "image";
    if (ct.startsWith("video/")) return "video";
    if (ct === "voice" || ct.includes("audio") || ct.includes("silk")) return "voice";
    return "file";
  }
  return "text";
}

/** 图片附件补宽高：QQ 入站不带尺寸，异步探测文件头后回填，手表端才能按原比例排版 */
const dimJobs = new Set<string>();
let dimActive = 0;

async function fillImageDims(userId: string, messageId: string, atts: AttachmentMeta[]): Promise<void> {
  for (let i = 0; i < atts.length; i++) {
    const att = atts[i];
    if (!att || att.width || att.height) continue;
    if (detectMsgType([att]) !== "image") continue;
    const url = att.url;
    if (!url) continue;
    const key = `${messageId}#${i}`;
    if (dimJobs.has(key)) continue;
    dimJobs.add(key);
    while (dimActive >= 3) await new Promise((r) => setTimeout(r, 120));
    dimActive += 1;
    try {
      const size = await probeRemoteImageSize(url);
      if (size && size.width > 0 && size.height > 0) {
        await updateMessageAttachmentDims(userId, messageId, i, size.width, size.height);
      }
    } catch {
      /* 探测失败保持原样，手表端退回 1:1 方框 */
    } finally {
      dimActive -= 1;
      dimJobs.delete(key);
    }
  }
}

export function previewOf(msgType: string, text: string | null): string {
  switch (msgType) {
    case "image":
      return "[图片]";
    case "video":
      return "[视频]";
    case "voice":
      return "[语音]";
    case "file":
      return "[文件]";
    case "sticker":
      return text ? `QQ表情：${text}` : "[QQ表情]";
    case "forward":
      try {
        const card = JSON.parse(text || "{}") as { title?: string };
        return card.title || "[聊天记录]";
      } catch {
        return "[聊天记录]";
      }
    default:
      return text || "";
  }
}

function parseTs(ts: unknown): number {
  if (typeof ts === "string") {
    const parsedDate = Date.parse(ts);
    if (!Number.isNaN(parsedDate)) return parsedDate;
    const asNumber = Number(ts);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber < 1e12 ? Math.floor(asNumber * 1000) : Math.floor(asNumber);
    }
    return Date.now();
  }
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
}

interface QuotedElementInfo {
  msgType: string;
  text: string | null;
  contentType?: string;
  filename?: string;
  url?: string;
  senderId?: string | null;
  senderName?: string | null;
}

function quotedElementInfo(msg: QQBotInboundMessage): QuotedElementInfo | null {
  if (!msg.refMsgIdx || !msg.msgElements || msg.msgElements.length === 0) return null;
  const quoted = msg.msgElements[0];
  const rawElement = (msg.raw as { msg_elements?: Array<Record<string, unknown>> } | null)?.msg_elements?.[0];
  const rawAuthor = rawElement?.author as
    | { id?: string; user_openid?: string; member_openid?: string; username?: string; bot?: boolean }
    | undefined;
  const qAtt = quoted.attachments?.[0];
  const qType = qAtt ? detectMsgType([{ contentType: qAtt.content_type } as AttachmentMeta]) : "text";
  return {
    msgType: qType,
    text: parseFaceTagsDisplay(humanizeMentionText(quoted.content?.trim() || null)),
    contentType: qAtt?.content_type,
    filename: qAtt?.filename,
    url: qAtt?.url,
    senderId: rawAuthor?.member_openid || rawAuthor?.user_openid || rawAuthor?.id || null,
    senderName: rawAuthor?.username?.trim() || null,
  };
}

function quotedPreview(info: QuotedElementInfo): string {
  return info.text || previewOf(info.msgType, null);
}

/**
 * QQ 表情/表情包会以 faceType 标签出现在文本里。这里解析成可读文字，
 * 避免聊天页直接显示一串 <faceType=...>。
 */
function parseFaceTagsInfo(text: string | null): { display: string | null; faceOnly: boolean } {
  if (!text) return { display: text, faceOnly: false };
  const labels: string[] = [];
  let index = 0;
  const out = text.replace(/<faceType=(\d+),faceId="[^"]*",ext="([^"]*)">/g, (_m, type: string, ext: string) => {
    let label = type === "4" ? "[动画表情]" : "[表情]";
    try {
      const decoded = Buffer.from(ext, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded) as { text?: string };
      if (parsed.text?.trim()) label = parsed.text.trim();
    } catch {
      // 解析失败时使用默认标签。
    }
    labels.push(label);
    const value = `[${labels[index]}]`;
    index += 1;
    return value;
  });
  const withoutTags = text.replace(/<faceType=(\d+),faceId="[^"]*",ext="([^"]*)">/g, "");
  const faceOnly = labels.length > 0 && withoutTags.trim() === "";
  // 一条消息里连续多个 QQ 自带表情时，用空格隔开，避免“开学啦知识增加”这类粘连。
  const display = faceOnly ? labels.join(" ") : out.trim();
  return { display: display || null, faceOnly };
}

function parseFaceTagsDisplay(text: string | null): string | null {
  return parseFaceTagsInfo(text).display;
}

/**
 * QQ 入站文本会把 @某人 传成 `<@openid>` / `<@!openid>` /
 * `<qqbot-at-user id="openid" />` 这样的占位符。这里用事件自带的 mentions
 * 昵称把它们还原成 `@昵称`，避免聊天页直接显示一串 openid。
 */
function humanizeMentionText(
  text: string | null,
  mentions?: QQBotInboundMessage["mentions"],
): string | null {
  if (!text) return text;

  const nameById = new Map<string, string>();
  for (const m of mentions ?? []) {
    const id = m?.member_openid || m?.user_openid || m?.id;
    const name = m?.nickname || m?.username;
    if (!id) continue;
    nameById.set(id.toLowerCase(), `@${name || id.slice(-6)}`);
  }

  const labelFor = (id: string): string =>
    nameById.get(id.toLowerCase()) || `@${id.slice(-6)}`;

  let out = text;
  out = out.replace(/<qqbot-at-user\s+id="([^"]+)"\s*\/?>/gi, (_m, id: string) => labelFor(id));
  out = out.replace(/<qqbot-at-everyone\s*\/?>/gi, "@全体成员");
  out = out.replace(/<@everyone>/gi, "@全体成员");
  out = out.replace(/<@!?([0-9A-Za-z_:-]+)>/g, (_m, id: string) => labelFor(id));
  return out.trim() || null;
}

interface ForwardAttachmentData {
  type: string;
  filename?: string | null;
  size?: string | null;
  url?: string | null;
}

interface ForwardItemData {
  sender?: string | null;
  text?: string | null;
  msgType?: string;
  attachments?: ForwardAttachmentData[];
  nested?: ForwardItemData[];
}

interface ForwardCardData {
  title: string;
  items: ForwardItemData[];
}

function parseForwardAttachment(value: string): ForwardAttachmentData | null {
  const type = /类型:(\S+)/.exec(value)?.[1]?.trim() || "";
  const filename = /文件名:(\S+)/.exec(value)?.[1]?.trim() || null;
  const size = /大小:(\S+)/.exec(value)?.[1]?.trim() || null;
  const url = /URL:(https?:\S+)/.exec(value)?.[1]?.trim() || null;
  if (!type && !url) return null;
  return { type, filename, size, url };
}

function forwardItemFromBlock(block: string): ForwardItemData {
  const item: ForwardItemData = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const content = /^\[消息内容\]\s*(.*)$/.exec(line);
    const sender = /^\[发送者\]\s*(.*)$/.exec(line);
    const msgType = /^\[消息类型\]\s*(.*)$/.exec(line);
    const attachment = /^\[附件(\d+)\]\s*(.*)$/.exec(line);
    if (content) item.text = (item.text ? `${item.text}\n` : "") + content[1].trim();
    else if (sender) item.sender = sender[1].trim();
    else if (msgType) item.msgType = msgType[1].trim();
    else if (attachment) {
      const parsed = parseForwardAttachment(attachment[2]);
      if (parsed) {
        item.attachments ??= [];
        item.attachments.push(parsed);
      }
    }
  }
  return item;
}

function parseForwardMessage(content: string): ForwardCardData | null {
  const text = content.trim();
  if (!text) return null;

  // ── 路径 A：QQ 直接给结构化 JSON（部分网关版本 msgType=102 时 content 就是卡片 JSON）
  // 这是最可靠的一路，优先尝试，避免把 JSON 当文本渲染出一堆乱码（旧版的韩文/乱码问题）。
  const fromJson = parseForwardFromJson(text);
  if (fromJson) return fromJson;

  // ── 路径 B：文档化的方括号文本格式
  const title = /^\[(.*?)\]\s*$/m.exec(text)?.[1]?.trim() || "聊天记录";
  const topBlocks = text.split(/^=== 消息 \d+ ===\s*$/m).slice(1).filter((b) => b.trim());
  if (topBlocks.length === 0) return null;

  const items: ForwardItemData[] = topBlocks.map((block) => {
    const nestedMatch = /^\[关联消息\]\s*$/m.exec(block);
    const topPart = nestedMatch ? block.slice(0, nestedMatch.index) : block;
    const nestedPart = nestedMatch ? block.slice((nestedMatch.index || 0) + nestedMatch[0].length) : "";
    const item = forwardItemFromBlock(topPart);

    if (nestedPart.trim()) {
      const nestedBlocks = nestedPart
        .split(/^--- 第\d+条 ---\s*$/m)
        .map((b) => b.trim())
        .filter(Boolean);
      item.nested = nestedBlocks.map(forwardItemFromBlock);
    }
    return item;
  });

  return { title, items };
}

/**
 * 解析 QQ 结构化「合并转发」卡片 JSON。
 *
 * 兼容三种常见字段命名（不同网关版本叫法不一）：
 *  - { prompt|title, news|items|messages|msg_list: [...] }
 *  - 元素形如 { desc|text|content, author|sender|nickname, ... }
 * 只要拿到非空的条目数组就认为解析成功。
 */
function parseForwardFromJson(text: string): ForwardCardData | null {
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;
  // 允许最外层是 { data: {...} } 或 { payload: {...} } 包裹
  const inner =
    (obj.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : null) ??
    (obj.payload && typeof obj.payload === "object" ? (obj.payload as Record<string, unknown>) : null) ??
    obj;

  const titleRaw =
    pickString(inner, ["prompt", "title", "desc", "summary"]) ||
    pickString(obj, ["prompt", "title"]) ||
    "聊天记录";

  let list: unknown =
    pickArray(inner, ["news", "items", "messages", "msg_list", "message_list", "list", "multi_msg"]) ??
    pickArray(obj, ["news", "items", "messages", "msg_list"]);

  if (!list) return null;
  if (!Array.isArray(list) || list.length === 0) return null;

  const items: ForwardItemData[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const item: ForwardItemData = {};
    item.sender = pickString(e, ["author", "sender", "nickname", "senderName", "name", "user_name"]) || null;
    item.msgType = pickString(e, ["msg_type", "msgType", "type"]) || undefined;
    item.text = pickString(e, ["desc", "text", "content", "message", "title", "value"]) || null;

    const atts = pickArray(e, ["attachments", "files", "media", "images"]);
    if (atts) {
      for (const a of atts) {
        if (!a || typeof a !== "object") continue;
        const ao = a as Record<string, unknown>;
        const url = pickString(ao, ["url", "src", "file_url", "audio_url", "image_url"]) || null;
        const type = pickString(ao, ["type", "kind", "file_type"]) || "";
        if (!url && !type) continue;
        item.attachments ??= [];
        item.attachments.push({
          type: normalizeForwardAttachmentType(type),
          filename: pickString(ao, ["filename", "file_name", "name"]) || null,
          size: pickString(ao, ["size", "file_size"]) || null,
          url,
        });
      }
    }
    // 至少要有点东西才收
    if (item.text || item.sender || (item.attachments && item.attachments.length > 0)) items.push(item);
  }

  if (items.length === 0) return null;
  return { title: String(titleRaw).slice(0, 40), items };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function pickArray(obj: Record<string, unknown>, keys: string[]): unknown[] | null {
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v) && v.length > 0) return v;
  }
  return null;
}

/** 把各种叫法归一成三种内部类型：图片 / 视频 / 语音 */
function normalizeForwardAttachmentType(type: string): string {
  const t = String(type || "").toLowerCase();
  if (t.includes("image") || t.includes("pic") || t.includes("图")) return "图片";
  if (t.includes("video") || t.includes("视频")) return "视频";
  if (t.includes("audio") || t.includes("voice") || t.includes("语音") || t.includes("音频")) return "语音";
  if (t) return t;
  return "附件";
}

async function handleInbound(userId: string, msg: QQBotInboundMessage): Promise<void> {
  const st = getState(userId);
  const bot = st.bot;
  if (!bot) return;
  if (msg.kind !== "c2c" && msg.kind !== "group") return;

  const scope: Scope = msg.kind === "c2c" ? "c2c" : "group";
  const peerId = scope === "c2c" ? msg.senderId : msg.groupOpenid || msg.replyTarget?.targetId;
  if (!peerId) return;

  if (msg.messageId) {
    const dup = await findMessageByQQId(userId, msg.messageId);
    if (dup) return; // 网关重推/断线重连后不重复入库
  }

  const attachments: AttachmentMeta[] =
    msg.attachments?.map((a) => ({
      url: a.url,
      contentType: normAttachmentContentType(a.content_type, a.filename, a.url),
      filename: a.filename,
      size: a.size,
      width: a.width,
      height: a.height,
      voiceWavUrl: a.voice_wav_url,
      asrText: a.asr_refer_text,
    })) ?? [];

  let msgType = detectMsgType(attachments);
  const createdAt = parseTs(msg.timestamp);
  const conversationId = convId(scope, peerId);

  // 发送者名称：优先使用 SDK 归一化的 username，其次从 raw.author 兜底；
  // 群成员立即写入 contacts，既修复乱码/openid，也能为成员抽屉提供缓存数据。
  const rawAuthor = (msg.raw as { author?: { username?: string } } | null)?.author;
  let senderName = msg.senderName?.trim() || rawAuthor?.username?.trim() || null;
  // 私聊事件经常不下发昵称。若该 openid 在群聊里已经出现过，复用群成员
  // 名称缓存，避免私聊标题/发送者继续显示成 openid。
  if (scope === "c2c" && !senderName && msg.senderId) {
    const groupContact = await getContact(userId, "member", msg.senderId);
    if (groupContact?.name) senderName = groupContact.name;
  }
  if (scope === "group" && msg.senderId) {
    if (senderName) {
      const member = await upsertContact(userId, "member", msg.senderId, { name: senderName });
      bus.emit(userId, "contact", member);
      // 同时缓存为私聊用户名称，之后该用户私聊机器人时可自动显示昵称。
      await upsertContact(userId, "user", msg.senderId, { name: senderName }).catch(() => {});
    } else {
      void resolveMember(userId, bot, peerId, msg.senderId).catch(() => {});
    }
  } else if (scope === "c2c" && senderName && msg.senderId) {
    const user = await upsertContact(userId, "user", msg.senderId, { name: senderName });
    bus.emit(userId, "contact", user);
  }

  // 被引用（回复）的消息内容。
  let reply: ReplyRef | null = null;
  const quoted = quotedElementInfo(msg);
  if (quoted) {
    reply = { preview: quotedPreview(quoted), senderName: quoted.senderName };
  }

  let text: string | null = null;
  if (msg.msgType === 102) {
    const card = parseForwardMessage(msg.content || "");
    if (card) {
      msgType = "forward";
      text = JSON.stringify(card);
    } else {
      // 解析失败也**绝不能**把原始 JSON 直接存成 text —— 那正是旧版
      // 「合并转发显示成韩文/乱码」的根因：卡片 JSON 被当普通文字渲染。
      // 退化为一张「空壳卡片」，正文只给一句可读提示。
      msgType = "forward";
      text = JSON.stringify({
        title: "聊天记录",
        items: [],
        unparsed: true,
      } satisfies ForwardCardData & { unparsed?: boolean });
    }
  }

  if (msgType !== "forward") {
    const face = parseFaceTagsInfo(humanizeMentionText((msg.content || "").trim() || null, msg.mentions));
    text = face.display;
    // 没有图片/视频/文件附件，且正文全部由 QQ 自带表情组成时，用 sticker 类型
    // 在网页里渲染成带边框的“QQ表情”气泡，避免被误判成普通文字。
    if (msgType === "text" && face.faceOnly) {
      msgType = "sticker";
    }
    // 图片/视频/文件消息里常见的 faceType=6 是表情包占位，不应再显示成第二行文字。
    if (msgType !== "text" && msgType !== "sticker") {
      text = face.faceOnly ? null : (text || "").replace(/【[^】]*】/g, "").trim() || null;
    }
  }
  const { row: message, duplicate } = await insertMessage({
    userId,
    qqMessageId: msg.messageId ?? null,
    referenceIdx: msg.msgIdx ?? null,
    conversationId,
    scope,
    peerId,
    direction: "in",
    senderId: msg.senderId,
    senderName,
    msgType,
    text,
    attachments,
    status: "sent",
    reply,
    createdAt,
  });
  if (duplicate) return;

  // 图片消息：后台补宽高（不阻塞入站流程）
  if (attachments.length) void fillImageDims(userId, message.id, attachments).catch(() => {});

  // 会话一定随消息出现（修复“有人发消息但列表不显示”）。
  await ensureConversation(userId, { id: conversationId, scope, peerId, title: peerId });
  const conv = await touchConversation(userId, conversationId, {
    lastMessageAt: Math.max(createdAt, Date.now()),
    lastPreview: previewOf(msgType, text),
    incrUnread: true,
  });

  // 若这条消息本身是一次「引用回复」，平台已经告诉我们被引用消息的
  // ref_msg_idx。旧版本没有持久化 msg_idx，导致老消息无法引用；这里把
  // ref_msg_idx 回填到本地匹配的原消息，后续再引用它时就能真正显示引用。
  if (quoted && msg.refMsgIdx && message.seq) {
    void (async () => {
      try {
        const candidates = await listUnreferencedMessageCandidates(userId, conversationId, message.seq);
        const target = candidates.find((c) => {
          if (c.msgType !== quoted.msgType) return false;
          if (quoted.msgType === "text") {
            return !!quoted.text && c.text === quoted.text;
          }
          const ca = c.attachments?.[0];
          if (!ca) return false;
          if (quoted.filename && ca.filename && quoted.filename === ca.filename) return true;
          if (quoted.url && ca.url && quoted.url === ca.url) return true;
          return !!quoted.contentType && ca.contentType === quoted.contentType;
        });
        if (target) {
          await setMessageReferenceIdx(userId, target.id, msg.refMsgIdx!);
          const updated = await getMessage(userId, target.id);
          if (updated) {
            const targetConv = await getConversation(userId, conversationId);
            bus.emit(userId, "message", { message: updated, conversation: targetConv });
          }
        }
      } catch (e) {
        log.debug("backfill reference_idx failed", e);
      }
    })();
  }

  // 群名 / 私聊名异步解析，拿到后回写会话并通知浏览器。
  //
  // bug#5 群聊性能修复：原实现**每条消息**都无条件跑一次 resolveGroup/upsertContact
  // + getConversation，再在拿到结果后判断「title 是否需要更新」。群聊刷屏时
  // 这是每条消息 2~3 次多余的数据库往返（对低配设备/高并发群是纯浪费）。
  //
  // 优化：先用刚才 touchConversation 已经拿到的 conv 判断「名字是否已解析」，
  // 已解析（title 不再是 peerId/占位名）就直接跳过整段异步解析与写回，
  // 把 N 条消息的 N 次解析降为「仅首次 1 次」，实时性完全不变。
  const titleResolved = !!conv && !!conv.title &&
    conv.title !== peerId && conv.title !== "QQ 群聊" && conv.title !== "QQ 好友";
  if (!titleResolved) {
    void (async () => {
      try {
        if (scope === "group") {
          const resolved = await resolveGroup(userId, bot, peerId);
          if (resolved) {
            const current = await getConversation(userId, conversationId);
            if (current && (current.title === peerId || current.title === "QQ 群聊" || !current.title)) {
              const updated = await updateConversationIdentity(userId, conversationId, {
                title: resolved.name,
                avatar: resolved.avatar ?? undefined,
              });
              if (updated) bus.emit(userId, "conversation", updated);
            }
          }
        } else if (senderName) {
          await upsertContact(userId, "user", peerId, { name: senderName });
          const current = await getConversation(userId, conversationId);
          if (current && !current.remark && (current.title === peerId || current.title === "QQ 好友")) {
            const updated = await updateConversationIdentity(userId, conversationId, { title: senderName });
            if (updated) bus.emit(userId, "conversation", updated);
          }
        }
      } catch (e) {
        log.warn("name resolution failed", e);
      }
    })();
  }

  bus.emit(userId, "message", { message, conversation: conv });
  log.debug(`inbound ${scope} msg from ${peerId} (${msgType})`);
}

// ── 原始事件（好友、群生命周期、入群申请） ───────────────────────────────

function toEpochSeconds(t: unknown): number {
  if (typeof t === "number") return t;
  if (typeof t === "string") {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return Math.floor(Date.now() / 1000);
}

async function handleRawEvent(userId: string, eventType: string, data: unknown): Promise<void> {
  const st = getState(userId);
  const bot = st.bot;
  if (!bot) return;

  try {
    if (eventType === "FRIEND_ADD") {
      const ev = data as { openid?: string; timestamp?: unknown; scene?: string; short_code?: string };
      if (!ev.openid) return;
      const event = await insertFriendEvent(userId, ev.openid, ev.scene ?? null, ev.short_code ?? null, toEpochSeconds(ev.timestamp));
      if (!event) return; // 幂等
      const id = convId("c2c", ev.openid);
      await ensureConversation(userId, { id, scope: "c2c", peerId: ev.openid, title: "QQ 好友", lastMessageAt: Date.now() });
      const conv = await getConversation(userId, id);
      if (conv) bus.emit(userId, "conversation", conv);
      bus.emit(userId, "friend_add", event);
      log.info(`FRIEND_ADD ${ev.openid}`);
      return;
    }

    if (eventType === "GROUP_ADD_ROBOT") {
      const ev = data as { group_openid?: string; op_member_openid?: string; timestamp?: unknown };
      if (!ev.group_openid) return;
      const event = await insertGroupRobotEvent(userId, "add", ev.group_openid, ev.op_member_openid ?? null, toEpochSeconds(ev.timestamp));
      const id = convId("group", ev.group_openid);
      const resolved = await resolveGroup(userId, bot, ev.group_openid);
      await ensureConversation(userId, {
        id,
        scope: "group",
        peerId: ev.group_openid,
        title: resolved?.name ?? "QQ 群聊",
        avatar: resolved?.avatar ?? null,
        lastMessageAt: Date.now(),
      });
      const conv = await getConversation(userId, id);
      if (conv) bus.emit(userId, "conversation", conv);
      bus.emit(userId, "group_robot_add", event);
      log.info(`GROUP_ADD_ROBOT ${ev.group_openid}`);
      return;
    }

    if (eventType === "GROUP_DEL_ROBOT") {
      const ev = data as { group_openid?: string; op_member_openid?: string; timestamp?: unknown };
      if (!ev.group_openid) return;
      const event = await insertGroupRobotEvent(userId, "del", ev.group_openid, ev.op_member_openid ?? null, toEpochSeconds(ev.timestamp));
      bus.emit(userId, "group_robot_del", event);
      log.info(`GROUP_DEL_ROBOT ${ev.group_openid}`);
      return;
    }

    if (eventType === "GROUP_JOIN_REQUEST") {
      const ev = data as {
        group_openid?: string;
        join_request_id?: string;
        member_openid?: string;
        username?: string;
        apply_at?: string;
        apply_source?: string;
        invited_by?: string;
        verify_info?: Record<string, unknown>;
        risk_tips?: string;
      };
      if (!ev.group_openid || !ev.member_openid) return;
      const req = await insertJoinRequest(userId, {
        joinRequestId: ev.join_request_id ?? null,
        groupOpenid: ev.group_openid,
        memberOpenid: ev.member_openid,
        username: ev.username ?? null,
        applyAt: ev.apply_at ?? null,
        applySource: ev.apply_source ?? null,
        invitedBy: ev.invited_by ?? null,
        verifyInfo: ev.verify_info ?? null,
        riskTips: ev.risk_tips ?? null,
      });
      if (req) bus.emit(userId, "join_request", req);
      log.info(`GROUP_JOIN_REQUEST ${ev.member_openid} -> ${ev.group_openid}`);
      return;
    }

    // 事件补全：好友删除 / 成员进出群 / 消息接收开关 / 订阅状态 / 按钮交互回调
    await handleExtraEvent(userId, eventType, data);
  } catch (e) {
    log.warn(`raw event ${eventType} handling failed`, e);
  }
}

// ── 入群申请审批 ──────────────────────────────────────────────────────────

export async function decideJoinRequest(userId: string, requestId: string, op: "approve" | "decline", reason?: string) {
  const reqs = await listJoinRequests(userId);
  const req = reqs.find((r) => r.id === requestId);
  if (!req) throw appError("INVALID_REQUEST", "入群申请不存在", "可能已被处理");
  if (req.status !== "pending") throw appError("INVALID_REQUEST", "该申请已被处理", "请刷新列表");
  const bot = requireBot(userId);
  const payload: Record<string, unknown> = {
    op,
    reject_reason: op === "decline" ? reason || undefined : undefined,
    add_to_member_blacklist: false,
  };
  // join_request_id 可能为 null（事件里没有下发）；显式 null 会被平台当作非法参数，需省略。
  if (req.joinRequestId) payload.join_request_id = req.joinRequestId;
  await bot.api.post(
    `/v2/groups/${encodeURIComponent(req.groupOpenid)}/approval_join_request/${encodeURIComponent(req.memberOpenid)}`,
    payload,
  );
  const updated = await updateJoinRequestStatus(userId, req.id, op === "approve" ? "approved" : "declined");
  if (updated) bus.emit(userId, "join_request", updated);
  return updated;
}

// ── 同步：群列表 + 历史消息（补齐离线期间的消息） ───────────────────────

interface HistoryMessage {
  id?: string;
  content?: string;
  timestamp?: string;
  msg_seq?: number | string;
  author?: { id?: string; member_openid?: string; user_openid?: string };
  attachments?: Array<{ content_type?: string; url?: string; filename?: string; size?: number; width?: number; height?: number }>;
}

async function ingestHistory(userId: string, bot: QQBot, conv: { id: string; scope: string; peerId: string }): Promise<number> {
  try {
    const path = conv.scope === "group" ? `/v2/groups/${encodeURIComponent(conv.peerId)}/messages` : `/v2/users/${encodeURIComponent(conv.peerId)}/messages`;
    const res = (await bot.api.get(path, { limit: 20 })) as { messages?: HistoryMessage[] } | null;
    const list = Array.isArray(res?.messages) ? res!.messages! : [];
    let added = 0;
    const botId = getState(userId).botInfo?.id ?? null;
    for (const hm of list) {
      if (!hm || !hm.id) continue;
      const dup = await findMessageByQQId(userId, hm.id);
      if (dup) continue;
      const attachments: AttachmentMeta[] = (hm.attachments ?? []).map((a) => ({
        url: a.url,
        contentType: normAttachmentContentType(a.content_type, a.filename, a.url),
        filename: a.filename,
        size: a.size,
        width: a.width,
        height: a.height,
      }));
      const msgType = detectMsgType(attachments);
      const text = parseFaceTagsDisplay(humanizeMentionText((hm.content || "").trim() || null));
      const direction: "in" | "out" = hm.author?.id && botId && hm.author.id === botId ? "out" : "in";
      let senderId = conv.scope === "group" ? (hm.author?.member_openid ?? null) : (hm.author?.user_openid ?? null);
      if (direction === "out") senderId = botId;
      let senderName: string | null = null;
      if (conv.scope === "group" && senderId && direction === "in") {
        const member = await getContact(userId, "member", senderId);
        senderName = member?.name ?? null;
        if (!senderName) void resolveMember(userId, bot, conv.peerId, senderId).catch(() => {});
      }
      const { duplicate } = await insertMessage({
        userId,
        qqMessageId: hm.id,
        conversationId: conv.id,
        scope: conv.scope as Scope,
        peerId: conv.peerId,
        direction,
        senderId,
        senderName,
        msgType,
        text,
        attachments,
        status: "sent",
        createdAt: parseTs(hm.timestamp),
      });
      if (!duplicate) added += 1;
    }
    return added;
  } catch {
    return 0; // 消息记录接口可能未开通权限，静默降级
  }
}

/** 从官方接口补齐入群申请（机器人离线或漏推事件时也不会丢）。 */
async function syncJoinRequests(userId: string, bot: QQBot, groupOpenid: string): Promise<number> {
  let cursor = "";
  let added = 0;
  let pages = 0;
  do {
    const query: Record<string, string | number> = { limit: 50 };
    if (cursor) query.cursor = cursor;
    const res = (await bot.api.get(`/v2/groups/${encodeURIComponent(groupOpenid)}/join_request_list`, query)) as {
      list?: Array<{
        join_request_id?: string;
        member_openid?: string;
        username?: string;
        apply_at?: string;
        apply_source?: string;
        invited_by?: string;
        verify_info?: Record<string, unknown>;
        risk_tips?: string;
      }>;
      next_cursor?: string;
    };
    const list = Array.isArray(res?.list) ? res.list : [];
    for (const item of list) {
      if (!item.member_openid) continue;
      const inserted = await insertJoinRequest(userId, {
        joinRequestId: item.join_request_id ?? null,
        groupOpenid,
        memberOpenid: item.member_openid,
        username: item.username ?? null,
        applyAt: item.apply_at ?? null,
        applySource: item.apply_source ?? null,
        invitedBy: item.invited_by ?? null,
        verifyInfo: item.verify_info ?? null,
        riskTips: item.risk_tips ?? null,
      });
      if (inserted) {
        added += 1;
        bus.emit(userId, "join_request", inserted);
      }
    }
    const next = typeof res?.next_cursor === "string" ? res.next_cursor : "";
    pages += 1;
    if (next && next !== cursor) cursor = next;
    else break;
  } while (cursor && pages < 10);
  return added;
}

export async function sync(userId: string, force: boolean): Promise<{ groups: number; messages: number; skipped?: boolean }> {
  const st = getState(userId);
  const bot = st.bot;
  if (!bot || st.status !== "connected") {
    return { groups: 0, messages: 0 };
  }
  const m = mgr();
  const last = m.lastSync.get(userId) ?? 0;
  if (!force && Date.now() - last < config.syncMinIntervalMs) {
    return { groups: 0, messages: 0, skipped: true };
  }
  if (st.syncing) return { groups: 0, messages: 0, skipped: true };
  st.syncing = true;
  m.lastSync.set(userId, Date.now());
  await emitStatus(userId);

  let groupCount = 0;
  let msgCount = 0;
  try {
    // 1. 拉取机器人所在的全部群，保证群聊一定出现在列表里。
    const seenGroupIds = new Set<string>();
    try {
      const res = (await bot.api.get("/v2/groups")) as {
        groups?: Array<{ group_openid?: string; group_name?: string; group_avatar?: string; member_count?: number }>;
      };
      const groups = Array.isArray(res?.groups) ? res.groups : [];
      for (const grp of groups) {
        if (!grp.group_openid) continue;
        seenGroupIds.add(grp.group_openid);
        groupCount += 1;
        const id = convId("group", grp.group_openid);
        if (grp.group_name) {
          await upsertContact(userId, "group", grp.group_openid, { name: grp.group_name, avatar: grp.group_avatar ?? null });
        }
        await ensureConversation(userId, {
          id,
          scope: "group",
          peerId: grp.group_openid,
          title: grp.group_name || undefined,
          avatar: grp.group_avatar ?? null,
        });
        const current = await getConversation(userId, id);
        if (current && grp.group_name && current.title !== grp.group_name && (current.title === current.peerId || current.title === "QQ 群聊")) {
          const updated = await updateConversationIdentity(userId, id, { title: grp.group_name, avatar: grp.group_avatar ?? null });
          if (updated) bus.emit(userId, "conversation", updated);
        }
        // 群管理员身份可拉取入群申请；没有权限时静默降级。
        await syncJoinRequests(userId, bot, grp.group_openid).catch(() => {});
      }
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      // /v2/groups 需要 QQ 开放平台给机器人开通「获取群列表」权限，普通 QQ 群机器人
      // 默认没有，会返回 404「不支持的调用」。这不是故障：群名在收到群消息时会用
      // /v2/groups/{group_openid}/info 解析，收发消息完全不受影响。
      if (/不支持的调用|404|Not Found/i.test(msg)) {
        log.info("跳过群列表同步：机器人未开通「获取群列表」权限（不影响收发消息）");
      } else {
        log.warn("sync group list failed", e);
      }
    }
    // 即使「获取群列表」接口未开通，也应从数据库里已有的群会话补拉入群申请。
    try {
      const conversations = await listConversations(userId);
      for (const conv of conversations) {
        if (conv.scope !== "group" || seenGroupIds.has(conv.peerId)) continue;
        await syncJoinRequests(userId, bot, conv.peerId).catch(() => {});
      }
    } catch (e) {
      log.warn("sync existing group conversations failed", e);
    }

    // QQ 官方 OpenAPI 目前没有“拉取单聊/群聊历史消息”的接口；历史消息由
    // 常驻网关持续入库，因此这里不再用不存在的 GET /messages 端点。

    await setSetting(userId, "lastSyncAt", String(Date.now()));
  } finally {
    st.syncing = false;
    await emitStatus(userId);
    bus.emit(userId, "sync", { groups: groupCount, messages: msgCount });
  }
  if (msgCount > 0) log.info(`sync done: +${msgCount} messages, ${groupCount} groups`);
  return { groups: groupCount, messages: msgCount };
}

// ── 出站消息 ──────────────────────────────────────────────────────────────

async function upsertOutConversation(userId: string, scope: Scope, peerId: string): Promise<string> {
  const id = convId(scope, peerId);
  const existing = await getConversation(userId, id);
  if (!existing) {
    let title = "QQ 好友";
    if (scope === "group") {
      const cached = await getContact(userId, "group", peerId);
      title = cached?.name || "QQ 群聊";
    } else {
      const cached = await getContact(userId, "user", peerId);
      title = cached?.name || "QQ 好友";
    }
    await ensureConversation(userId, { id, scope, peerId, title });
  }
  return id;
}

function emitMessage(userId: string, row: import("@/db/schema").MessageRow): void {
  void getConversation(userId, row.conversationId)
    .then((conv) => {
      bus.emit(userId, "message", { message: row, conversation: conv });
    })
    .catch((e) => log.warn("emitMessage failed to load conversation", e));
}

export interface SendTextOptions {
  text: string;
  replyTo?: string | null; // 被引用消息的本地 id
  mentions?: Array<{ openid: string; name?: string | null }>;
}

export async function sendText(userId: string, scope: Scope, peerId: string, opts: SendTextOptions) {
  const trimmed = (opts.text || "").trim();
  const mentionList = (opts.mentions ?? []).filter((m) => m?.openid && typeof m.openid === "string");
  if (!trimmed && mentionList.length === 0) throw appError("INVALID_REQUEST", "消息内容不能为空", "请输入文字");
  const bot = requireBot(userId);
  const st = getState(userId);
  const conversationId = await upsertOutConversation(userId, scope, peerId);

  const mentionTags = mentionList
    .map((m) => (m.openid === "everyone" ? "<qqbot-at-everyone />" : `<qqbot-at-user id="${m.openid}" />`))
    .join(" ");
  const displayText =
    mentionList.length > 0
      ? [mentionList.map((m) => `@${m.name || m.openid.slice(-6)}`).join(" "), trimmed].filter(Boolean).join(" ")
      : trimmed;
  const wireText = [mentionTags, trimmed].filter(Boolean).join(" ");

  // 解析引用：5 分钟内走被动回复（QQ 内显示引用），否则本地引用 + 主动消息。
  let reply: ReplyRef | null = null;
  let passiveMsgId: string | undefined;
  let quoteMessageId: string | undefined;
  if (opts.replyTo) {
    const { getMessage } = await import("./repo");
    const original = await getMessage(userId, opts.replyTo);
    // 被引用消息必须属于同一会话：否则 replyPreview 显示的是别的群的消息，
    // 且平台 message_reference 跨会话无效。
    if (original && original.conversationId === conversationId) {
      reply = {
        qqMsgId: original.qqMessageId,
        localId: original.id,
        preview: original.msgType === "text" ? (original.text ?? "") : previewOf(original.msgType, null),
        senderName: original.senderName,
      };
      if (original.qqMessageId && Date.now() - original.createdAt < config.passiveReplyWindowMs) {
        passiveMsgId = original.qqMessageId;
      }
      // QQ 主动引用消息需要被引用消息的平台 msg_id，而不是 ref_idx。
      // 入站消息、以及已送达的出站消息都保存了 qqMessageId，优先用它。
      if (original.qqMessageId) quoteMessageId = original.qqMessageId;
    }
  }

  const target: ReplyTarget = { scope, targetId: peerId, msgId: passiveMsgId };
  const message = (
    await insertMessage({
      userId,
      conversationId,
      scope,
      peerId,
      direction: "out",
      senderId: st.botInfo?.id ?? null,
      senderName: st.botInfo?.username ?? null,
      msgType: "text",
      text: displayText || wireText,
      status: "sending",
      reply,
      createdAt: Date.now(),
    })
  ).row;
  emitMessage(userId, message);
  await touchConversation(userId, conversationId, { lastMessageAt: Date.now(), lastPreview: displayText || wireText });

  // 立即把本地消息返回给前端，实际 QQ 发送放到后台，前端通过 SSE 实时更新发送结果。
  void deliverText(
    userId,
    bot,
    message.id,
    conversationId,
    scope,
    peerId,
    wireText,
    displayText || wireText,
    passiveMsgId,
    quoteMessageId,
    mentionList.length > 0,
  ).catch((e) => {
    log.error("deliver text failed", e);
  });
  return message;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface SendCommandOptions {
  show: string;
  command: string;
}

/**
 * 发送「蓝色可点击指令」：
 * - 群聊使用 qqbot-cmd-input：点击后把 command 填入输入框（QQ 限制群聊不能一键直发）。
 * - 私聊使用 qqbot-cmd-enter：点击后直接发送 command。
 */
export async function sendCommand(userId: string, scope: Scope, peerId: string, opts: SendCommandOptions) {
  const show = (opts.show || "").trim();
  const command = (opts.command || "").trim();
  if (!show) throw appError("INVALID_REQUEST", "请填写蓝色字显示内容", "例如：靳宇航");
  if (!command) throw appError("INVALID_REQUEST", "请填写点击后发送的文字", "例如：lbj试试");
  if (show.length > 100 || command.length > 100) throw appError("INVALID_REQUEST", "蓝色字和发送文字均不能超过 100 个字符", "请精简内容");

  const bot = requireBot(userId);
  const st = getState(userId);
  const conversationId = await upsertOutConversation(userId, scope, peerId);

  // QQ 官方私聊「回车指令」可以做到“点一下立即发送”，但没有 show 字段，
  // 因此私聊里蓝色标签必须和实际发送文字一致；官方 API 会拒绝 cmd-enter 携带 show。
  // 群聊只支持“参数指令”，会把 command 填入输入框，用户可以自定义蓝色显示字 show。
  // 属性值必须做 XML 转义（不能用 URL 编码，否则 QQ 端原样显示 %20 等）。
  const markdown =
    scope === "group"
      ? `<qqbot-cmd-input text="${escapeXmlAttr(command)}" show="${escapeXmlAttr(show)}" reference="false" />`
      : `<qqbot-cmd-enter text="${escapeXmlAttr(command)}" />`;
  const previewText =
    scope === "group"
      ? `蓝色字「${show}」 → 点击填入「${command}」`
      : `点击立即发送「${command}」`;

  const message = (
    await insertMessage({
      userId,
      conversationId,
      scope,
      peerId,
      direction: "out",
      senderId: st.botInfo?.id ?? null,
      senderName: st.botInfo?.username ?? null,
      msgType: "text",
      text: previewText,
      status: "sending",
      createdAt: Date.now(),
    })
  ).row;
  emitMessage(userId, message);
  await touchConversation(userId, conversationId, { lastMessageAt: Date.now(), lastPreview: previewText });

  void deliverText(
    userId,
    bot,
    message.id,
    conversationId,
    scope,
    peerId,
    markdown,
    previewText,
    undefined,
    undefined,
    true,
  ).catch((e) => {
    log.error("deliver interactive command failed", e);
  });
  return message;
}

export interface SendRichTextOptions {
  text: string;
  imageUrls?: string[] | null;
  mentions?: Array<{ openid: string; name?: string | null }>;
}

function contentTypeFromImageUrl(url: string): string {
  const ext = (url.match(/\.(gif|webp|png|jpe?g)(\?|$)/i)?.[1] || "png").toLowerCase();
  return ext === "jpg" ? "image/jpeg" : `image/${ext}`;
}

function renderInlineMentions(
  text: string,
  mentions: Array<{ openid: string; name?: string | null }>,
): { markdown: string; preview: string } {
  let markdown = text;
  // 「@全体成员」有独立的专用标签，必须单独处理，不能走 at-user。
  for (const m of mentions) {
    if (!m?.openid) continue;
    if (m.openid === "everyone") {
      const label = `@${m.name || "全体成员"}`;
      const idx = markdown.indexOf(label);
      if (idx === -1) continue;
      markdown = `${markdown.slice(0, idx)}<qqbot-at-everyone />${markdown.slice(idx + label.length)}`;
      continue;
    }
    const label = `@${m.name || m.openid.slice(-6)}`;
    const idx = markdown.indexOf(label);
    if (idx === -1) continue;
    markdown = `${markdown.slice(0, idx)}<qqbot-at-user id="${escapeXmlAttr(m.openid)}" />${markdown.slice(idx + label.length)}`;
  }
  return { markdown, preview: text };
}

/**
 * 图文 + @ 一起发：官方 Markdown 支持在 content 里同时写 @标签、文本和图片。
 * 图片必须使用公网可访问 URL，QQ 会下载转存。
 */
export async function sendRichText(userId: string, scope: Scope, peerId: string, opts: SendRichTextOptions) {
  const trimmed = (opts.text || "").trim();
  const imageUrls = (opts.imageUrls ?? [])
    .map((url) => (url || "").trim())
    .filter(Boolean);
  if (!trimmed && imageUrls.length === 0) throw appError("INVALID_REQUEST", "图文消息内容不能为空", "请输入文字或上传图片");
  for (const imageUrl of imageUrls) {
    if (!/^https?:\/\//i.test(imageUrl)) {
      throw appError("INVALID_REQUEST", "图片链接必须以 http(s):// 开头", "请上传图片或填写公网图片 URL");
    }
  }

  const bot = requireBot(userId);
  const st = getState(userId);
  const conversationId = await upsertOutConversation(userId, scope, peerId);
  const mentionList = (opts.mentions ?? []).filter((m) => m?.openid && typeof m.openid === "string");

  // 支持“文字中间 @人、@多个人”：按用户输入的 @名字 在正文原位置替换成官方
  // `<qqbot-at-user id="openid" />` 标签，而不是把所有 @ 都强制提到文字前面。
  const rendered = renderInlineMentions(trimmed, mentionList);
  const markdownParts: string[] = [];
  if (rendered.markdown) markdownParts.push(rendered.markdown);
  for (const imageUrl of imageUrls) markdownParts.push(`\n![图片 #360px #360px](${imageUrl})`);
  const markdown = markdownParts.join("\n");
  const displayNames = mentionList.map((m) => `@${m.name || m.openid.slice(-6)}`).join(" ");
  const previewText = [displayNames, trimmed].filter(Boolean).join(" ") || (imageUrls.length > 0 ? `[图片${imageUrls.length > 1 ? ` x${imageUrls.length}` : ""}]` : "[图文消息]");
  const attachments = imageUrls.map((url) => ({
    url,
    contentType: contentTypeFromImageUrl(url),
    filename: "图文图片",
  }));

  const message = (
    await insertMessage({
      userId,
      conversationId,
      scope,
      peerId,
      direction: "out",
      senderId: st.botInfo?.id ?? null,
      senderName: st.botInfo?.username ?? null,
      msgType: imageUrls.length > 0 ? "image" : "text",
      text: previewText,
      attachments,
      status: "sending",
      createdAt: Date.now(),
    })
  ).row;
  emitMessage(userId, message);
  await touchConversation(userId, conversationId, { lastMessageAt: Date.now(), lastPreview: previewText });

  void deliverText(
    userId,
    bot,
    message.id,
    conversationId,
    scope,
    peerId,
    markdown,
    previewText,
    undefined,
    undefined,
    true,
  ).catch((e) => {
    log.error("deliver rich markdown failed", e);
  });
  return message;
}

async function deliverText(
  userId: string,
  bot: QQBot,
  messageId: string,
  conversationId: string,
  scope: Scope,
  peerId: string,
  text: string,
  previewText: string,
  passiveMsgId?: string,
  quoteMessageId?: string,
  asMarkdown = false,
): Promise<void> {
  const attemptSend = async (msgId?: string) => {
    const target: ReplyTarget = { scope, targetId: peerId, msgId };
    const common = {
      target,
      messageReference: quoteMessageId ? { message_id: quoteMessageId } : undefined,
    };
    const sent: MessageResponse = asMarkdown
      ? await bot.send({
          ...common,
          msgType: MsgType.MARKDOWN,
          markdown: { content: text },
        })
      : await bot.send({
          ...common,
          msgType: MsgType.TEXT,
          content: text,
        });
    return sent;
  };
  try {
    let sent: MessageResponse;
    try {
      // 已有真实 message_reference 时不需要被动 msg_id，直接发主动引用。
      sent = await attemptSend(quoteMessageId ? undefined : passiveMsgId);
    } catch (err) {
      // 被动回复失败时自动降级为主动消息，避免发送失败。
      if (passiveMsgId && !quoteMessageId) {
        sent = await attemptSend(undefined);
      } else {
        throw err;
      }
    }
    if (sent?.id) await setMessageQQId(userId, messageId, sent.id);
    if (sent?.ext_info?.ref_idx) await setMessageReferenceIdx(userId, messageId, sent.ext_info.ref_idx);
    const ok = await updateMessageStatus(userId, messageId, "sent", null);
    await touchConversation(userId, conversationId, { lastMessageAt: Date.now(), lastPreview: previewText });
    if (ok) emitMessage(userId, ok);
  } catch (err) {
    const detail = classifyError(err);
    const failed = await updateMessageStatus(userId, messageId, "failed", detail.message);
    if (failed) emitMessage(userId, failed);
  }
}

export interface SendMediaOptions {
  localPath: string;
  localId?: string;
  fileName: string;
  contentType: string;
  size?: number;
  kind: "image" | "video" | "voice" | "file";
  replyTo?: string | null;
}

function fileTypeFor(kind: string): MediaFileType {
  switch (kind) {
    case "image":
      return MediaFileType.IMAGE;
    case "video":
      return MediaFileType.VIDEO;
    case "voice":
      return MediaFileType.VOICE;
    default:
      return MediaFileType.FILE;
  }
}

/**
 * 把任意音频统一转成 QQ 可直传的 24kHz 单声道 WAV。
 * 非音频文件返回 null，由上层降级为普通文件发送。
 */
async function prepareVoiceForUpload(
  inputPath: string,
  inputName: string,
  contentType?: string,
): Promise<{ localPath: string; fileName: string; cleanup: () => Promise<void> } | null> {
  const ext = path.extname(inputName || "").toLowerCase();
  const mime = (contentType || "").toLowerCase();
  const audioExt = /\.(mp3|wav|m4a|aac|ogg|opus|flac|amr|silk|webm|mp4|m4b|wma|ape|aiff?|au|ra|mov|mkv|avi|3gp|wmv|asf)$/i.test(ext);
  const audioMime = mime.startsWith("audio/") || mime.startsWith("video/") || mime.includes("ogg") || mime.includes("wav") || mime.includes("mp4") || mime.includes("webm");
  // 用户选择“语音”时统一尝试转码；即使扩展名/ MIME 无法识别也交给 ffmpeg
  // 判断。ffmpeg 解不出音频时会返回 null，上层再降级为普通文件发送。
  if (!audioExt && !audioMime && ext && ![".bin", ".unknown"].includes(ext)) {
    // 明显是非音频扩展名时，不浪费 2 分钟去尝试转码。
    return null;
  }

  const outPath = path.join(config.outDir, `${randomUUID()}.wav`);
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "24000",
      "-c:a",
      "pcm_s16le",
      outPath,
    ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const base = path.basename(inputName || "voice").replace(/\.[^.]+$/, "") || "voice";
    return {
      localPath: outPath,
      fileName: `${base}.wav`,
      cleanup: async () => {
        try {
          await unlink(outPath);
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    try {
      await unlink(outPath);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** 视频直传失败时，统一转成 QQ 支持的 mp4/H.264 后重试。 */
async function prepareVideoForUpload(
  inputPath: string,
  inputName: string,
): Promise<{ localPath: string; fileName: string; cleanup: () => Promise<void> } | null> {
  const outPath = path.join(config.outDir, `${randomUUID()}.mp4`);
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-vf",
      "scale='min(1280,iw)':-2",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      outPath,
    ], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    const base = path.basename(inputName || "video").replace(/\.[^.]+$/, "") || "video";
    return {
      localPath: outPath,
      fileName: `${base}.mp4`,
      cleanup: async () => {
        try {
          await unlink(outPath);
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    try {
      await unlink(outPath);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** 图片直传失败时，统一转成 PNG 后重试。 */
async function prepareImageForUpload(
  inputPath: string,
  inputName: string,
): Promise<{ localPath: string; fileName: string; cleanup: () => Promise<void> } | null> {
  const outPath = path.join(config.outDir, `${randomUUID()}.png`);
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-f",
      "image2",
      outPath,
    ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const base = path.basename(inputName || "image").replace(/\.[^.]+$/, "") || "image";
    return {
      localPath: outPath,
      fileName: `${base}.png`,
      cleanup: async () => {
        try {
          await unlink(outPath);
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    try {
      await unlink(outPath);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export async function sendMedia(userId: string, scope: Scope, peerId: string, opts: SendMediaOptions) {
  const bot = requireBot(userId);
  const st = getState(userId);
  const conversationId = await upsertOutConversation(userId, scope, peerId);

  let reply: ReplyRef | null = null;
  let passiveMsgId: string | undefined;
  let quoteMessageId: string | undefined;
  if (opts.replyTo) {
    const { getMessage } = await import("./repo");
    const original = await getMessage(userId, opts.replyTo);
    if (original && original.conversationId === conversationId) {
      reply = {
        qqMsgId: original.qqMessageId,
        localId: original.id,
        preview: original.msgType === "text" ? (original.text ?? "") : previewOf(original.msgType, null),
        senderName: original.senderName,
      };
      if (original.qqMessageId && Date.now() - original.createdAt < config.passiveReplyWindowMs) {
        passiveMsgId = original.qqMessageId;
      }
      if (original.qqMessageId) quoteMessageId = original.qqMessageId;
    }
  }

  const localId = opts.localId || randomUUID();
  const message = (
    await insertMessage({
      userId,
      conversationId,
      scope,
      peerId,
      direction: "out",
      senderId: st.botInfo?.id ?? null,
      senderName: st.botInfo?.username ?? null,
      msgType: opts.kind,
      attachments: [{ localId, contentType: opts.contentType, filename: opts.fileName, size: opts.size }],
      status: "sending",
      reply,
      createdAt: Date.now(),
    })
  ).row;
  emitMessage(userId, message);

  const preview = previewOf(opts.kind, null);
  await touchConversation(userId, conversationId, { lastMessageAt: Date.now(), lastPreview: preview });

  // 返回本地消息后立即在后台执行转码/上传/发送，前端通过 SSE 拿到进度和最终状态。
  void deliverMedia(userId, bot, message.id, conversationId, scope, peerId, opts, passiveMsgId, quoteMessageId).catch((e) => {
    log.error("deliver media failed", e);
  });
  return message;
}

async function deliverMedia(
  userId: string,
  bot: QQBot,
  messageId: string,
  conversationId: string,
  scope: Scope,
  peerId: string,
  opts: SendMediaOptions,
  passiveMsgId?: string,
  quoteMessageId?: string,
): Promise<void> {
  const preparedVoice = opts.kind === "voice" ? await prepareVoiceForUpload(opts.localPath, opts.fileName, opts.contentType) : null;
  let sendLocalPath = preparedVoice?.localPath ?? opts.localPath;
  let sendFileName = preparedVoice?.fileName ?? opts.fileName;
  let preparedFallback: { localPath: string; fileName: string; cleanup: () => Promise<void> } | null = null;

  const preview = previewOf(opts.kind, null);

  const attempt = async (msgId: string | undefined, ft: MediaFileType): Promise<MessageResponse> => {
    const upload: UploadMediaResponse = await bot.uploadMedia({
      target: { scope, targetId: peerId },
      fileType: ft,
      localPath: sendLocalPath,
      fileName: sendFileName,
      srvSendMsg: false,
      onProgress: (uploaded, total) => {
        bus.emit(userId, "upload_progress", { messageId, uploaded, total });
      },
    });
    return bot.send({
      target: { scope, targetId: peerId, msgId },
      msgType: MsgType.MEDIA,
      media: { file_info: upload.file_info },
      messageReference: quoteMessageId ? { message_id: quoteMessageId } : undefined,
    });
  };

  try {
    const candidates: Array<{ msgId?: string; fileType: MediaFileType }> = [];
    candidates.push({ msgId: quoteMessageId ? undefined : passiveMsgId, fileType: fileTypeFor(opts.kind) });
    if (passiveMsgId && !quoteMessageId) {
      candidates.push({ fileType: fileTypeFor(opts.kind) });
    }
    // 语音格式不受支持时降级为普通文件；被动消息超时/次数用尽时降级为主动消息。
    if (opts.kind === "voice") {
      candidates.push({ msgId: quoteMessageId ? undefined : passiveMsgId, fileType: MediaFileType.FILE });
      if (passiveMsgId && !quoteMessageId) {
        candidates.push({ fileType: MediaFileType.FILE });
      }
    }

    let lastError: unknown = null;
    let sentId: string | undefined;
    let sentRefIdx: string | undefined;
    for (const candidate of candidates) {
      try {
        const sent = await attempt(candidate.msgId, candidate.fileType);
        sentId = sent?.id;
        sentRefIdx = sent?.ext_info?.ref_idx;
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }

    // 视频/图片直传因格式不被 QQ 接受而失败时，用 ffmpeg 转成受支持格式后重试。
    if (lastError && (opts.kind === "video" || opts.kind === "image")) {
      const prepared =
        opts.kind === "video"
          ? await prepareVideoForUpload(opts.localPath, opts.fileName)
          : await prepareImageForUpload(opts.localPath, opts.fileName);
      if (prepared) {
        preparedFallback = prepared;
        sendLocalPath = prepared.localPath;
        sendFileName = prepared.fileName;
        const fallbackTargets: Array<{ msgId?: string; fileType: MediaFileType }> = [
          { msgId: quoteMessageId ? undefined : passiveMsgId, fileType: fileTypeFor(opts.kind) },
        ];
        if (passiveMsgId && !quoteMessageId) {
          fallbackTargets.push({ fileType: fileTypeFor(opts.kind) });
        }
        for (const candidate of fallbackTargets) {
          try {
            const sent = await attempt(candidate.msgId, candidate.fileType);
            sentId = sent?.id;
            sentRefIdx = sent?.ext_info?.ref_idx;
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
          }
        }
      }
    }

    if (lastError) throw lastError;
    if (sentId) await setMessageQQId(userId, messageId, sentId);
    if (sentRefIdx) await setMessageReferenceIdx(userId, messageId, sentRefIdx);
    const ok = await updateMessageStatus(userId, messageId, "sent", null);
    await touchConversation(userId, conversationId, { lastMessageAt: Date.now(), lastPreview: preview });
    if (ok) emitMessage(userId, ok);
  } catch (err) {
    const detail = classifyError(err);
    const failed = await updateMessageStatus(userId, messageId, "failed", detail.message);
    if (failed) emitMessage(userId, failed);
  } finally {
    if (preparedVoice) await preparedVoice.cleanup().catch(() => {});
    if (preparedFallback) await preparedFallback.cleanup().catch(() => {});
  }
}

/** 撤回消息（平台接口支持时生效）。 */
export async function recallMessage(userId: string, messageId: string): Promise<void> {
  const { getMessage } = await import("./repo");
  const row = await getMessage(userId, messageId);
  if (!row) throw appError("INVALID_REQUEST", "消息不存在", "请刷新后重试");
  if (!row.qqMessageId) throw appError("INVALID_REQUEST", "该消息无法撤回", "仅已成功送达的消息可撤回");
  const bot = requireBot(userId);
  await bot.recallMessage({ scope: row.scope as Scope, targetId: row.peerId }, row.qqMessageId);
  const updated = await updateMessageStatus(userId, row.id, "recalled", null);
  const conv = await getConversation(userId, row.conversationId);
  if (updated) bus.emit(userId, "message", { message: updated, conversation: conv });
}

/** 重发失败的消息（文本或已上传到本地的富媒体）。 */
export async function resendFailed(userId: string, messageId: string) {
  const { getMessage } = await import("./repo");
  const row = await getMessage(userId, messageId);
  if (!row) throw appError("INVALID_REQUEST", "消息不存在", "请刷新后重试");
  if (row.status !== "failed") throw appError("INVALID_REQUEST", "仅失败的消息可重发", "");
  const bot = requireBot(userId);

  const isText = row.msgType === "text" && !!row.text;
  const mediaKinds = new Set(["image", "video", "voice", "file"]);
  const isMedia = mediaKinds.has(row.msgType);
  if (!isText && !isMedia) throw appError("INVALID_REQUEST", "该类型消息暂不支持重发", "请手动重新发送");

  const ok = await updateMessageStatus(userId, row.id, "sending", null);
  if (ok) emitMessage(userId, ok);
  try {
    let sentId: string | undefined;
    let preview = "";
    if (isText) {
      const sent = await bot.sendText({ scope: row.scope as Scope, targetId: row.peerId }, row.text!);
      sentId = sent?.id;
      preview = row.text!;
    } else {
      const att = row.attachments[0];
      if (!att?.localId) throw appError("INVALID_REQUEST", "原文件已不存在，无法重发", "请重新上传");
      const localPath = outPathFor(att.localId);
      if (!localPath) throw appError("INVALID_REQUEST", "原文件已不存在，无法重发", "请重新上传");
      const preparedVoice = row.msgType === "voice" ? await prepareVoiceForUpload(localPath, att.filename || "voice", att.contentType) : null;
      let preparedFallback: { localPath: string; fileName: string; cleanup: () => Promise<void> } | null = null;
      let sendLocalPath = preparedVoice?.localPath ?? localPath;
      let sendFileName = preparedVoice?.fileName ?? (att.filename || "file");
      const cleanupPrepared = async () => {
        if (preparedVoice) await preparedVoice.cleanup().catch(() => {});
        if (preparedFallback) await preparedFallback.cleanup().catch(() => {});
      };
      try {
        const attempt = async (fileType: MediaFileType) => {
          const res = await bot.sendMedia({
            target: { scope: row.scope as Scope, targetId: row.peerId },
            fileType,
            localPath: sendLocalPath,
            fileName: sendFileName,
            onProgress: (uploaded, total) => {
              bus.emit(userId, "upload_progress", { messageId: row.id, uploaded, total });
            },
          });
          return res.message?.id;
        };

        let lastError: unknown = null;
        const candidates: MediaFileType[] = [fileTypeFor(row.msgType)];
        if (row.msgType === "voice") candidates.push(MediaFileType.FILE);
        for (const ft of candidates) {
          try {
            sentId = await attempt(ft);
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
          }
        }

        if (lastError && (row.msgType === "video" || row.msgType === "image")) {
          const prepared =
            row.msgType === "video"
              ? await prepareVideoForUpload(localPath, att.filename || "video")
              : await prepareImageForUpload(localPath, att.filename || "image");
          if (prepared) {
            preparedFallback = prepared;
            sendLocalPath = prepared.localPath;
            sendFileName = prepared.fileName;
            for (const ft of [fileTypeFor(row.msgType)]) {
              try {
                sentId = await attempt(ft);
                lastError = null;
                break;
              } catch (err) {
                lastError = err;
              }
            }
          }
        }

        if (lastError) throw lastError;
        preview = previewOf(row.msgType, null);
      } finally {
        await cleanupPrepared();
      }
    }
    if (sentId) await setMessageQQId(userId, row.id, sentId);
    const done = await updateMessageStatus(userId, row.id, "sent", null);
    await touchConversation(userId, row.conversationId, { lastMessageAt: Date.now(), lastPreview: preview });
    if (done) emitMessage(userId, done);
    return done;
  } catch (err) {
    const detail = classifyError(err);
    const failed = await updateMessageStatus(userId, row.id, "failed", detail.message);
    if (failed) emitMessage(userId, failed);
    throw new AppError(detail);
  }
}

export async function renameConversation(userId: string, id: string, remark: string) {
  const trimmed = remark.trim();
  const updated = await setConversationRemark(userId, id, trimmed ? trimmed : null);
  if (!updated) throw appError("INVALID_REQUEST", "会话不存在", "请刷新后重试");
  bus.emit(userId, "conversation", updated);
  return updated;
}

export async function markConversationRead(userId: string, id: string): Promise<void> {
  await markRead(userId, id);
  const conv = await getConversation(userId, id);
  if (conv) bus.emit(userId, "conversation", conv);
}

// ── 群成员列表 ───────────────────────────────────────────────────────────

export interface MemberEntry {
  openid: string;
  name: string | null;
  avatar: string | null;
  joinTime: string | null;
}

export async function listGroupMembers(userId: string, groupOpenid: string): Promise<MemberEntry[]> {
  let bot: QQBot | null = null;
  try {
    bot = requireBot(userId);
  } catch {
    bot = null;
  }

  let apiMembers: Array<{ member_openid?: string; join_time?: string; nick?: string; avatar?: string }> = [];
  if (bot) {
    try {
      const res = (await bot.api.get(`/v2/groups/${encodeURIComponent(groupOpenid)}/members`, { limit: 200 })) as {
        members?: Array<{ member_openid?: string; join_time?: string; nick?: string; avatar?: string }>;
      };
      apiMembers = Array.isArray(res?.members) ? res.members : [];
    } catch (e) {
      log.warn("group members API failed, fallback to cached contacts", e);
    }
  }

  const byOpenid = new Map<string, MemberEntry>();
  for (const m of apiMembers) {
    if (!m.member_openid) continue;
    let name = m.nick || null;
    let avatar = m.avatar || null;
    if (!name) {
      const cached = await getContact(userId, "member", m.member_openid);
      if (cached?.name) {
        name = cached.name;
        avatar = avatar || cached.avatar;
      }
    } else {
      const contact = await upsertContact(userId, "member", m.member_openid, { name, avatar });
      bus.emit(userId, "contact", contact);
    }
    byOpenid.set(m.member_openid, { openid: m.member_openid, name, avatar, joinTime: m.join_time ?? null });
  }

  // 接口无权限时，只使用“这个群里真正发过言的人”兜底，避免把其他群的成员
  // 混进当前群的 @ 列表。只要这个群里有人发消息，就会实时补齐并出现在列表里。
  for (const sender of await listInboundGroupSenders(userId, groupOpenid)) {
    if (!sender.senderId || byOpenid.has(sender.senderId)) continue;
    const cached = await getContact(userId, "member", sender.senderId);
    byOpenid.set(sender.senderId, {
      openid: sender.senderId,
      name: cached?.name || sender.senderName || null,
      avatar: cached?.avatar || null,
      joinTime: null,
    });
  }

  const result: MemberEntry[] = [];
  result.push(...byOpenid.values());
  return result;
}

// ── 连接诊断 ───────────────────────────────────────────────────────────────

export interface DiagnoseResult {
  network: Array<{ host: string; ok: boolean; latencyMs: number | null; error?: string }>;
  token: {
    tested: boolean;
    ok: boolean;
    appId?: string;
    code?: number | string;
    message?: string;
  };
}

/** 自检：网络连通性 + 凭证校验，帮助定位“连不上机器人”的原因。 */
export async function diagnose(userId: string, appIdInput?: string, appSecretInput?: string): Promise<DiagnoseResult> {
  let appId = appIdInput?.trim();
  let secret = appSecretInput?.trim();
  if (!appId || !secret) {
    const creds = await storedCreds(userId);
    if (creds) {
      appId = appId || creds.appId;
      secret = secret || creds.secret;
    }
  }

  const network: DiagnoseResult["network"] = [];
  for (const host of ["bots.qq.com", "api.sgroup.qq.com"]) {
    const started = Date.now();
    try {
      await fetch(`https://${host}/`, { method: "GET", signal: AbortSignal.timeout(6000) });
      network.push({ host, ok: true, latencyMs: Date.now() - started });
    } catch (e) {
      network.push({ host, ok: false, latencyMs: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  let token: DiagnoseResult["token"] = { tested: false, ok: false };
  if (appId && secret) {
    try {
      const res = await fetch("https://bots.qq.com/app/getAppAccessToken", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "qqbot-web-client/1.0" },
        body: JSON.stringify({ appId, clientSecret: secret }),
        signal: AbortSignal.timeout(10000),
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; code?: number; message?: string };
      if (res.ok && body.access_token) {
        token = { tested: true, ok: true, appId: maskSecret(appId, 4) };
      } else {
        token = { tested: true, ok: false, appId: maskSecret(appId, 4), code: body.code ?? res.status, message: body.message || `HTTP ${res.status}` };
      }
    } catch (e) {
      token = {
        tested: true,
        ok: false,
        appId: maskSecret(appId, 4),
        code: "NETWORK",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  return { network, token };
}

export { listJoinRequests };
