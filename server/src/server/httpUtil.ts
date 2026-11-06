import { getSessionUserFromRequest } from "@/lib/auth";
import { AppError, appError, errorBody } from "@/lib/errors";
import type { User } from "@/db/schema";

export const nodeRuntime = { runtime: "nodejs" as const, dynamic: "force-dynamic" as const };

/**
 * 推导「服务器对外可见的 origin」。
 *
 * 反向代理（含本项目发布平台）会把 `Host` / `X-Forwarded-Host` 改写成内部回源地址，
 * 因此不能直接采用。优先级：
 *   1. 显式配置 `QQRT_PUBLIC_ORIGIN`（最可靠，自托管可写死对外域名）；
 *   2. 请求头 `Origin`（浏览器自带，反向代理无权改写）——适合前端同域调用场景；
 *   3. `X-Forwarded-Host` / `Host`（过滤掉明显的内部/回源地址后取第一个）。
 *
 * 返回形如 `https://example.com`（不含尾斜杠），无法判定时返回空串。
 */
export function publicOriginOf(req: Request): string {
  const explicit = (process.env.QQRT_PUBLIC_ORIGIN || "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;

  // 浏览器自带的 Origin 最可信（代理不会改写它）。
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const u = new URL(origin);
      if (u.protocol === "http:" || u.protocol === "https:") return `${u.protocol}//${u.host}`;
    } catch {
      /* 忽略非法 Origin，继续尝试转发头 */
    }
  }

  const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim() || "https";
  for (const raw of [req.headers.get("x-forwarded-host"), req.headers.get("host")]) {
    if (!raw) continue;
    for (const seg of raw.split(",")) {
      const h = seg.trim();
      if (h) return `${proto}://${h}`;
    }
  }
  return "";
}

/**
 * 判定一个 host 是否是「可信的对外域名」。
 *
 * 反向代理会把 Host/X-Forwarded-Host 改成内部回源地址，这些**内部地址不能作为
 * CSRF 的可信基准**（它们不是用户访问的域名）。这里用一个宽松但有效的启发式：
 *   - 纯 IP：仅公网地址可信，内网/环回/链路本地一律不信任；
 *   - 含 `sandbox` / `internal` / `cloudstudio` 关键字的回源域名不信任；
 *   - 形如 `3000-<hash>.xxx` 的沙箱回源主机名不信任。
 * 其余（真实公网域名）视为可信。
 */
function isTrustedPublicHost(host: string): boolean {
  const h = String(host || "").toLowerCase().replace(/:\d+$/, "");
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const p = h.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 169 && p[1] === 254) return false;
    return true;
  }
  if (h.includes("sandbox") || h.includes("internal") || h.includes("cloudstudio")) return false;
  if (/^\d+-[0-9a-f]{16,}\./.test(h)) return false;
  return true;
}

/**
 * CSRF 防护：校验请求的 `Origin` 是否可信，拒绝跨站请求。
 * 仅对会产生副作用的 mutation 接口生效（登录/注册本身不需要 —— 它们会建立
 * 新会话，不属于跨站可利用的已认证操作）。
 *
 * 反向代理兼容性说明：
 * 发布平台/网关会把 `Host` / `X-Forwarded-Host` 重写成**内部回源地址**
 * （如 `3000-xxxx.sandbox.cloudstudio.club`），而浏览器发出的 `Origin` 仍是
 * 用户实际访问的对外域名。直接比较两者会 100% 误判为跨站。
 *
 * 判定策略（按可信度）：
 *   1. 显式配置 `QQRT_PUBLIC_ORIGIN` → 只认它（最严格，自托管推荐）；
 *   2. 进程内记住**首次见到的可信公网 Origin**（同域前端第一次调用即登记），
 *      之后所有 mutation 必须与它一致 —— 这样既不依赖被改写的 Host，
 *      又能真正拦住跨站来源；
 *   3. 若尚无登记值，且本次 `Origin` 是可信公网域名（非 IP/内网/沙箱）→ 登记并放行。
 *
 * 攻击者站点发起的请求会带攻击者域名的 Origin（可信公网域名但 ≠ 已登记域名），
 * 因此会被第 2 步拦下；同时 Cookie 为 `SameSite=Lax`，跨站请求本就不携带凭据。
 */
/**
 * CSRF 防护：校验请求的 `Origin` 是否可信，拒绝跨站请求。
 * 仅对会产生副作用的 mutation 接口生效。
 *
 * 背景：发布平台/网关会把 `Host` / `X-Forwarded-Host` 重写成**内部回源地址**
 * （如 `3000-xxxx.sandbox.cloudstudio.club`），而浏览器发出的 `Origin` 仍是
 * 用户实际访问的对外域名。直接比较两者会 100% 误判为跨站。
 *
 * 判定策略（**不做“首次见到即信任”的自动登记**，否则攻击者站点抢先请求即可
 * 把自己的域名登记为可信来源）：
 *   1. 显式配置 `QQRT_PUBLIC_ORIGIN` → 只认它；
 *   2. 否则从代理链（`Forwarded` / `X-Forwarded-Host` / `Host`）里挑出
 *      **可信公网域名**，要求 `Origin` 与之完全一致；
 *   3. 代理链里找不到可信公网域名时（如本地开发直连、上游未透传原始 Host）：
 *      - 若请求自带 `Origin` 且该 host 是可信公网域名 → 放行（已通过第 2 步语义
 *        无法判定，但浏览器 Origin 本身即攻击者无法伪造的同域标识）；
 *      - 若 `Origin` host 明显是内网/IP/沙箱回源 → 放行（本地开发/反代场景，
 *        此时无对外域名可比对；凭据仍受鉴权层保护）。
 *
 * 关键点：**绝不因为某个 Origin 先到达就把它当作可信**；可信来源只能来自
 * 显式配置或代理链中的公网 Host。
 */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (!origin) return; // 同源 GET 触发/非浏览器客户端，不强制

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw appError("PERMISSION_DENIED", "跨站请求被拒绝", "");
  }
  const originHost = parsed.host.toLowerCase();
  const originOrigin = `${parsed.protocol}//${parsed.host}`.toLowerCase();

  // 1) 显式配置：只认它。
  const explicit = (process.env.QQRT_PUBLIC_ORIGIN || "").trim().replace(/\/+$/, "");
  if (explicit) {
    if (originOrigin !== explicit.toLowerCase()) {
      throw appError("PERMISSION_DENIED", "跨站请求被拒绝", "");
    }
    return;
  }

  // 2) 从代理链中提取可信公网 host（只信环境提供的，不信请求方自称的 Origin）。
  const forwarded = collectForwardedHosts(req);

  // 3) 关键修复（回归 bug#12）：除了「可信公网 host」，**本次请求自身的 Host 也
  //    必须纳入比对**。本地开发/直连场景下 `Host` 是 `127.0.0.1:3005` 这类
  //    内网地址（被 `isTrustedPublicHost` 判为不可信），旧实现会让 forwarded
  //    变成空集，随后走「Origin 是可信公网域名就放行」的分支 —— 于是攻击者
  //    Origin `https://evil.example.com` 被放行，CSRF 形同虚设。
  //    正确语义：浏览器同域请求的 Origin 一定等于它访问的 Host；因此先把请求
  //    自身的 Host（无论公网/内网/IP）作为**可直接比对的基准**。
  const ownHosts = collectOwnHosts(req);

  if (forwarded.length > 0) {
    // 代理链里有明确的公网域名：Origin 必须与其中之一一致，否则视为跨站。
    if (forwarded.includes(originHost)) return;
    // 代理链里存在公网域名时，请求自身的内网 Host 不再作为可信基准（防止
    // 攻击者伪造 Host 头绕过）；只有 Origin 命中公网 Host 才放行。
    throw appError("PERMISSION_DENIED", "跨站请求被拒绝", "");
  }

  // 4) 代理链没有可信公网域名：用请求自身 Host（含内网/IP/localhost）比对。
  //    这正是本地开发、内网自托管、以及上游未透传公网 Host 的场景。
  if (ownHosts.length > 0) {
    if (ownHosts.includes(originHost)) return;
    throw appError("PERMISSION_DENIED", "跨站请求被拒绝", "");
  }

  // 5) 极端兜底：既无代理链也无 Host 头。此时无法比对，只能放行（凭据仍受
  //    鉴权层保护）。正常情况下浏览器请求必定带 Host，不会走到这里。
  return;
}

/**
 * 收集**本次请求自身**的 Host（不过滤内网/IP/localhost），用于本地开发/直连场景
 * 的同源比对。会同时考虑 `X-Forwarded-Host` 与 `Host`，取所有候选项。
 */
function collectOwnHosts(req: Request): string[] {
  const out = new Set<string>();
  for (const raw of [req.headers.get("x-forwarded-host"), req.headers.get("host")]) {
    if (!raw) continue;
    for (const seg of raw.split(",")) {
      const h = seg.trim().toLowerCase();
      if (h) out.add(h);
    }
  }
  return [...out];
}

/**
 * 收集代理链中出现的 host，仅返回**可信公网域名**（过滤内部/回源/沙箱地址）。
 * 同时解析标准的 `Forwarded: host=...` 头。
 */
function collectForwardedHosts(req: Request): string[] {
  const out = new Set<string>();
  const forwarded = req.headers.get("forwarded");
  if (forwarded) {
    for (const part of forwarded.split(",")) {
      const m = part.match(/(?:^|;)\s*host\s*=\s*"?([^";]+)"?/i);
      if (m && m[1]) {
        const h = m[1].trim().toLowerCase();
        if (isTrustedPublicHost(h)) out.add(h);
      }
    }
  }
  for (const raw of [req.headers.get("x-forwarded-host"), req.headers.get("host")]) {
    if (!raw) continue;
    for (const seg of raw.split(",")) {
      const h = seg.trim().toLowerCase();
      if (h && isTrustedPublicHost(h)) out.add(h);
    }
  }
  return [...out];
}


export async function requireUser(req: Request): Promise<User> {
  const user = await getSessionUserFromRequest(req);
  if (!user) throw appError("AUTH_ERROR", "未登录或登录已过期", "请重新登录");
  return user;
}

export function ok<T extends object>(data: T, init?: ResponseInit): Response {
  return Response.json({ success: true, ...data }, init);
}

export function fail(err: unknown, fallbackStatus = 400): Response {
  // 业务校验类错误（如"用户名已被注册"）直接展示原文，不加"请稍后重试"。
  const body =
    err instanceof AppError
      ? { success: false as const, error: err.detail }
      : err instanceof Error && err.name === "Error"
        ? {
            success: false as const,
            error: { source: "app" as const, code: "APP", type: "INVALID_REQUEST", message: err.message, retryable: false, suggestion: "" },
          }
        : errorBody(err);
  const status = body.error.type === "AUTH_ERROR" ? 401 : body.error.type === "RATE_LIMIT" ? 429 : fallbackStatus;
  return Response.json(body, { status });
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw appError("INVALID_REQUEST", "请求体不是有效的 JSON", "请检查请求格式");
  }
}
