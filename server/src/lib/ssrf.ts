import { appError } from "@/lib/errors";

/**
 * SSRF 防护：拒绝内网/回环/链路本地等私网地址，只允许公网 http(s) 目标。
 * 合并转发子媒体由 QQ CDN（bots.qq.com / *.qq.com 等公网域名）提供，
 * 无需访问本机或内网服务。
 *
 * 例外：`MEDIA_ALLOW_PRIVATE_HOSTS`（默认未设置 = 严格模式）。
 * 这是给「本机联调 / 端到端测试」用的显式白名单，例如：
 *   MEDIA_ALLOW_PRIVATE_HOSTS=127.0.0.1:18989,localhost
 * 生产环境请勿设置；未设置时行为与之前完全一致（私网一律拒绝）。
 */
function allowlist(): string[] {
  return String(process.env.MEDIA_ALLOW_PRIVATE_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function assertSafeUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw appError("INVALID_REQUEST", "仅支持 http(s) 媒体地址", "");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = allowlist();
  if (allowed.includes(hostname) || allowed.includes(`${hostname}:${url.port}`)) {
    return raw;
  }
  if (hostname === "localhost" || hostname === "localhost.localdomain") {
    throw appError("INVALID_REQUEST", "媒体地址不可指向本机", "");
  }
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  if (isIp) {
    const parts = hostname.split(".").map(Number);
    const [a, b, c] = parts;
    if (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // 链路本地（含云元数据 169.254.169.254）
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0 ||
      a === 100 && b >= 64 && b <= 127 // 运营商级 NAT
    ) {
      throw appError("INVALID_REQUEST", "媒体地址不可指向内网", "");
    }
    if (a >= 224) {
      throw appError("INVALID_REQUEST", "媒体地址不可为组播/保留地址", "");
    }
  } else {
    // 明确指向内网的域名
    if (/\.internal$|\.local$|\.localhost$|\.home\.arpa$/i.test(hostname)) {
      throw appError("INVALID_REQUEST", "媒体地址不可指向内网", "");
    }
  }
  return raw;
}
