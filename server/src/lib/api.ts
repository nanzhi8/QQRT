/**
 * 浏览器端 API 客户端（精简版）。
 *
 * 服务端网页现在只保留「登录账号 + 绑定 QQ 机器人二要素 + 常驻接收开关」，
 * 因此这里只保留账号与机器人相关的接口，聊天相关接口已全部移除。
 */

export interface BotInfo {
  id: string;
  username: string;
  avatar?: string;
}

export interface BotStatus {
  status: "disconnected" | "connecting" | "connected" | "error";
  connected: boolean;
  hasCredentials: boolean;
  receive: boolean;
  appId: string | null;
  bot: BotInfo | null;
  lastError: string | null;
  syncing: boolean;
  lastSyncAt: number | null;
}

export interface ErrorDetail {
  source: string;
  code: number | string;
  type: string;
  message: string;
  retryable: boolean;
  suggestion: string;
}

export class ApiError extends Error {
  detail: ErrorDetail;
  constructor(detail: ErrorDetail) {
    super(detail.message || "请求失败");
    this.name = "ApiError";
    this.detail = detail;
  }
}

export interface AuthResult {
  user: { id: string; username: string };
  token?: string;
}

/** 部署在子路径（例如 /qqbot）时，所有地址都带上前缀。 */
export const PUBLIC_BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");

export function pathOf(path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${PUBLIC_BASE_PATH}${clean}`;
}

// ── token 兜底通道 ────────────────────────────────────────────────────────

const TOKEN_KEY = "qqc_token";

let memoryToken: string | null = null;

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
    return true;
  } catch {
    return false;
  }
}

export function getAuthToken(): string | null {
  return memoryToken ?? getStoredToken();
}

export function setAuthToken(token: string | null): boolean {
  memoryToken = token;
  return setStoredToken(token);
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * 拼请求地址：除了 basePath，还要带上两类查询参数
 *  - sharecode：托管分享链接要求每个请求都带（反代会拦截缺参数的请求）
 *  - t：token 的查询参数形式。托管反代会剥掉 Authorization 头，只认 ?t=
 */
function withAuthQuery(path: string): string {
  const url = pathOf(path);
  const params = new URLSearchParams();
  if (typeof window !== "undefined") {
    const sharecode = new URLSearchParams(window.location.search).get("sharecode");
    if (sharecode) params.set("sharecode", sharecode);
  }
  const token = getAuthToken();
  if (token) params.set("t", token);
  const qs = params.toString();
  if (!qs) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${qs}`;
}

/** 页面内跳转用：保留分享链接的 sharecode，否则跳过去会被拦成「链接不完整」 */
export function linkOf(path: string): string {
  const url = pathOf(path);
  if (typeof window === "undefined") return url;
  const sharecode = new URLSearchParams(window.location.search).get("sharecode");
  return sharecode ? `${url}?sharecode=${encodeURIComponent(sharecode)}` : url;
}

function q(url: string, init?: RequestInit): Promise<Response> {
  const headers = { ...(init?.headers as Record<string, string> | undefined), ...authHeaders() };
  return fetch(withAuthQuery(url), { ...init, headers });
}

function normalizeError(body: unknown): ApiError {
  const b = body as { error?: ErrorDetail };
  if (b?.error) return new ApiError(b.error);
  return new ApiError({
    source: "client",
    code: "HTTP",
    type: "NETWORK_ERROR",
    message: "请求失败",
    retryable: true,
    suggestion: "请稍后重试",
  });
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: ErrorDetail };
  if (!res.ok || body.success === false) throw normalizeError(body);
  return body as T;
}

export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    return e.detail.suggestion ? `${e.detail.message}（${e.detail.suggestion}）` : e.detail.message;
  }
  return e instanceof Error ? e.message : "操作失败，请稍后重试";
}

export const api = {
  // ── 账号 ──
  async login(username: string, password: string): Promise<AuthResult> {
    const res = await q("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = await json<AuthResult>(res);
    if (body.token) setAuthToken(body.token);
    return body;
  },
  async logout(): Promise<void> {
    await q("/api/auth/logout", { method: "POST" }).catch(() => {});
    setAuthToken(null);
  },

  // ── 机器人 ──
  async status(): Promise<BotStatus> {
    const body = await json<{ status: BotStatus }>(await q("/api/bot/status", { cache: "no-store" }));
    return body.status;
  },
  async connect(appId?: string, appSecret?: string): Promise<BotStatus> {
    const res = await q("/api/bot/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, appSecret }),
    });
    return (await json<{ status: BotStatus }>(res)).status;
  },
  async disconnect(clearCreds = false): Promise<BotStatus> {
    const res = await q("/api/bot/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clearCreds }),
    });
    return (await json<{ status: BotStatus }>(res)).status;
  },
  async setReceive(on: boolean): Promise<BotStatus> {
    const res = await q("/api/bot/receive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on }),
    });
    return (await json<{ status: BotStatus }>(res)).status;
  },

  // ── 手表登录短码 ──
  /** 把服务器地址上传到短链服务，返回短码供手表输入。 */
  async shareHost(host?: string): Promise<{ success: true; code: string; url: string; host: string }> {
    const res = await q("/api/watch/share-host", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: host || "" }),
    });
    return json<{ success: true; code: string; url: string; host: string }>(res);
  },
};
