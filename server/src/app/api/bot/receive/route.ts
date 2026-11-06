import { setReceive } from "@/server/botManager";
import { assertSameOrigin, fail, ok, readJson, requireUser } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 常驻接收开关：开 = 服务器持续收消息；关 = 停止接收。 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const user = await requireUser(req);
    const { on } = await readJson<{ on?: boolean }>(req);
    const status = await setReceive(user.id, !!on);
    return ok({ status });
  } catch (e) {
    return fail(e);
  }
}
