import { connect } from "@/server/botManager";
import { assertSameOrigin, fail, ok, readJson, requireUser } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const user = await requireUser(req);
    const body = await readJson<{ appId?: string; appSecret?: string }>(req);
    const status = await connect(user.id, body.appId, body.appSecret);
    return ok({ status });
  } catch (e) {
    return fail(e);
  }
}
