import { appError } from "@/lib/errors";

/**
 * 极简进程内限流器：以 key 为维度统计窗口内请求次数，超限抛 RATE_LIMIT。
 * 用于登录/注册/连接机器人等防爆破/防滥用接口。单实例部署足够；
 * 若多实例部署可换成 Redis，这里不做过度设计。
 */
export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateLimitEntry>();

/** 窗口内允许的次数。默认：1 分钟 20 次。 */
export function checkRateLimit(key: string, limit = 20, windowMs = 60_000): void {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  entry.count += 1;
  if (entry.count > limit) {
    throw appError(
      "RATE_LIMIT",
      "操作过于频繁，请稍后再试",
      `请在 ${Math.ceil((entry.resetAt - now) / 1000)} 秒后重试`,
      true,
    );
  }
}

/** 宽松的 IP 维度限流（登录失败等场景）。 */
export function ipKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return `ip:${first}`;
  }
  const ip = req.headers.get("x-real-ip");
  return ip ? `ip:${ip}` : `ip:unknown`;
}

/** 账号维度限流，兼顾 IP 维度（避免同 IP 爆破不同账号）。 */
export function authRateLimit(req: Request, username: string): void {
  const name = (username || "").toString().slice(0, 64).toLowerCase() || "unknown";
  checkRateLimit(ipKey(req), 30, 60_000);
  checkRateLimit(`auth:${name}`, 10, 60_000);
}

export function clearRateLimit(key: string): void {
  buckets.delete(key);
}