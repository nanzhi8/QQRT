import { fail, ok, requireUser } from "@/server/httpUtil";
import {
  getTrimSetting,
  setSetting,
  TRIM_COUNT_KEY,
  TRIM_MAX_N,
  TRIM_MIN_N,
  TRIM_SETTING_KEY,
} from "@/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 手表端设置同步（bug#7）。
 *
 * 「消息自动清理」以前只存在手表本地 storage，服务端并不知道，于是服务端在
 * 每条消息落库后仍然固定裁剪到 32 条 —— 客户端把开关关掉也无效。
 * 现在把该设置同步到服务端（settings 表），服务端裁剪策略完全跟随用户设置：
 *   - trim_on = "0" → 不裁剪（仅保留 5000 条安全上限）；
 *   - trim_on = "1" → 保留最近 trim_n 条。
 */

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const trim = await getTrimSetting(user.id);
    return ok({ trim });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { trimOn?: unknown; trimN?: unknown };

    if (body.trimOn !== undefined) {
      await setSetting(user.id, TRIM_SETTING_KEY, body.trimOn ? "1" : "0");
    }
    if (body.trimN !== undefined) {
      const n = Number(body.trimN);
      if (!Number.isFinite(n) || n < TRIM_MIN_N || n > TRIM_MAX_N) {
        return fail(new Error(`保留条数需在 ${TRIM_MIN_N}~${TRIM_MAX_N} 之间`), 400);
      }
      await setSetting(user.id, TRIM_COUNT_KEY, String(Math.floor(n)));
    }

    const trim = await getTrimSetting(user.id);
    return ok({ trim });
  } catch (e) {
    return fail(e);
  }
}
