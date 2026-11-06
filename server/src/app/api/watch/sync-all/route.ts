import { sync } from "@/server/botManager";
import { listWatchConversations } from "@/server/watch";
import { fail, ok, requireUser } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const result = await sync(user.id, true);
    const conversations = await listWatchConversations(user.id);
    return ok({ synced: conversations.length, result, conversations });
  } catch (e) {
    return fail(e);
  }
}
