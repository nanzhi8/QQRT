import { assertSameOrigin, fail, ok, publicOriginOf, readJson, requireUser } from "@/server/httpUtil";
import { setSetting } from "@/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 手表登录短码：把「服务端自己的访问地址」上传到短链服务（默认 dpaste.com），
 * 返回一个短码。手表输入法不便输入长域名，用户只需在手表「服务器地址」里
 * 输入这串短码即可。
 *
 * - 默认上传的域名取当前浏览器访问所用的 Host（含 NEXT_PUBLIC_BASE_PATH 前缀）。
 * - 也允许显式传 host（便于自定义）。
 * - 短链服务基址可用 DPASTE_API_BASE 覆盖（默认官方 dpaste，便于私有部署/测试）。
 */

const DPASTE_API_BASE = process.env.DPASTE_API_BASE || "https://dpaste.com/api/v2/";
const DPASTE_UA = "qqbot-web-client/1.0";
const SHARE_CODE_SETTING_KEY = "last_share_code";

function normalizeHost(raw: unknown, origin: string): string {
  let s = String(raw || "").trim();
  if (!s) s = origin;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/+$/, "");
}

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const user = await requireUser(req);
    const body = await readJson<{ host?: string }>(req);

    // 对外域名：优先取浏览器 Origin / 显式配置，避免被代理改写的内部 Host 污染短码。
    const origin = publicOriginOf(req);

    const host = normalizeHost(body.host, origin);
    if (!/^https?:\/\/[^/\s]+(\/[^\s]*)?$/.test(host)) {
      return fail(new Error("无法确定服务器地址"));
    }

    const form = new URLSearchParams({ content: host, expiry_days: "365" });
    const res = await fetch(DPASTE_API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": DPASTE_UA },
      body: form.toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return fail(new Error(`短链服务返回 ${res.status}`));

    // dpaste 成功时响应体就是创建好的 URL（纯文本），例如 https://dpaste.com/58TWHUHSC
    const text = (await res.text()).trim();
    const m = text.match(/([A-Za-z0-9]{4,})\s*$/);
    const code = m ? m[1] : "";
    if (!code) return fail(new Error("短链服务返回异常"));

    await setSetting(user.id, SHARE_CODE_SETTING_KEY, code);
    return ok({ code, url: text, host });
  } catch (e) {
    return fail(e);
  }
}
