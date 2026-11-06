import { disconnect } from "@/server/botManager";
import { assertSameOrigin, fail, ok, readJson, requireUser } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const user = await requireUser(req);
    const body = await readJson<{ clearCreds?: boolean }>(req).catch((): { clearCreds?: boolean } => ({}));
    const status = await disconnect(user.id, { clearCreds: !!body?.clearCreds, setReceiveOff: false });
    return ok({ status });
  } catch (e) {
    return fail(e);
  }
}
