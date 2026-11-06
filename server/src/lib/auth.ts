import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { ensureSchema } from "@/db/bootstrap";
import { sessions, users, type User } from "@/db/schema";

/**
 * 多用户认证。
 *
 * 凭证按优先级从三处读取：
 * 1. httpOnly Cookie（常规浏览器访问）；
 * 2. `Authorization: Bearer <token>` 请求头（Cookie 被 iframe / 隐私模式
 *    等环境屏蔽时的兜底）；
 * 3. `?token=` 查询参数（仅供 EventSource 等无法自定义请求头的场景）。
 *
 * 每个浏览器/设备拿到独立的 session token，所有数据按 user_id 隔离，
 * 多设备登录不同账号互不串号。
 */

export const SESSION_COOKIE = "qqc_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [algo, salt, hash] = stored.split(":");
    if (algo !== "scrypt" || !salt || !hash) return false;
    const check = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
  } catch {
    return false;
  }
}

export function newId(): string {
  return crypto.randomUUID();
}

export function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export async function createSession(userId: string, userAgent: string | null): Promise<{ token: string; maxAge: number }> {
  await ensureSchema();
  const now = Date.now();
  const token = newToken();
  await db.insert(sessions).values({
    token,
    userId,
    userAgent: userAgent?.slice(0, 300) ?? null,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  return { token, maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, token));
}

/**
 * 自适应 Cookie：HTTPS 环境使用 `SameSite=None; Secure`（兼容 iframe 预览），
 * 纯 HTTP 部署降级为 `SameSite=Lax`（None 必须搭配 Secure，否则浏览器拒收）。
 */
export function buildSessionCookie(req: Request, token: string, maxAge: number): string {
  const proto = req.headers.get("x-forwarded-proto") || (req.url.startsWith("https:") ? "https" : "http");
  const secure = proto.split(",")[0].trim() === "https";
  const sameSite = secure ? "None" : "Lax";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=${sameSite}${secure ? "; Secure" : ""}; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

async function findUserByToken(token: string): Promise<User | null> {
  if (!token || token.length > 200) return null;
  await ensureSchema();
  const rows = await db
    .select({ user: users, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, Date.now())))
    .limit(1);
  return rows[0]?.user ?? null;
}

function bearerTokenFrom(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** 页面/服务端组件用：Cookie → Authorization 头 → 可选的查询参数 token。 */
export async function getSessionUser(
  queryToken?: string,
): Promise<{ user: User; token: string | null } | null> {
  const store = await cookies();
  const cookieToken = store.get(SESSION_COOKIE)?.value;
  if (cookieToken) {
    const user = await findUserByToken(cookieToken);
    // 关键：把实际生效的 session token 一并交给客户端，保证即使浏览器屏蔽了
    // Cookie / localStorage，后续 API 请求也能通过 Bearer 头完成鉴权。
    if (user) return { user, token: cookieToken };
  }
  const h = await headers();
  const bearer = bearerTokenFrom(h.get("authorization"));
  if (bearer) {
    const user = await findUserByToken(bearer);
    if (user) return { user, token: bearer };
  }
  if (queryToken) {
    const user = await findUserByToken(queryToken);
    if (user) return { user, token: queryToken };
  }
  return null;
}

/** API 路由用：从请求自身解析（Cookie → Bearer 头 → ?token=）。 */
export async function getSessionUserFromRequest(req: Request): Promise<User | null> {
  const raw = req.headers.get("cookie") || "";
  const match = raw.split(/;\s*/).find((p) => p.startsWith(`${SESSION_COOKIE}=`));
  let cookieToken: string | null = null;
  if (match) {
    try {
      cookieToken = decodeURIComponent(match.slice(SESSION_COOKIE.length + 1));
    } catch {
      cookieToken = match.slice(SESSION_COOKIE.length + 1);
    }
  }
  if (cookieToken) {
    const user = await findUserByToken(cookieToken);
    if (user) return user;
  }
  const bearer = bearerTokenFrom(req.headers.get("authorization"));
  if (bearer) {
    const user = await findUserByToken(bearer);
    if (user) return user;
  }
  try {
    // 兼容两种查询参数鉴权：`token`（网页 EventSource）与 `t`（手表客户端，参考
    // 官方 RPK 示例的 `?t=` 传 token 形式）。
    const sp = new URL(req.url).searchParams;
    const tokenParam = sp.get("token") ?? sp.get("t");
    if (tokenParam) return await findUserByToken(tokenParam);
  } catch {
    /* invalid url */
  }
  return null;
}

export async function registerUser(username: string, password: string): Promise<User> {
  await ensureSchema();
  const name = username.trim();
  if (!/^[\u4e00-\u9fa5A-Za-z0-9_]{2,20}$/.test(name)) {
    throw new Error("用户名需为 2-20 位中文、字母、数字或下划线");
  }
  if (password.length < 6 || password.length > 64) {
    throw new Error("密码长度需为 6-64 位");
  }
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, name)).limit(1);
  if (existing.length > 0) throw new Error("该用户名已被注册");
  const user: User = { id: newId(), username: name, passwordHash: hashPassword(password), createdAt: Date.now() };
  await db.insert(users).values(user);
  return user;
}

export async function loginUser(username: string, password: string): Promise<User> {
  await ensureSchema();
  const rows = await db.select().from(users).where(eq(users.username, username.trim())).limit(1);
  const user = rows[0];
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new Error("用户名或密码错误");
  }
  return user;
}
