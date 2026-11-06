import { fail, ok, requireUser } from "@/server/httpUtil";
import { listWatchConversations, listWatchMessagesSince, maxWatchSeq } from "@/server/watch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * bug#20：全局消息同步 —— 首页轮询一次拉取**所有会话**的新消息（不再
 * 单个聊天各拉各的）。聊天列表（未读/预览）与消息增量一并返回，首页一个
 * 请求完成全部同步；各会话的新消息由客户端写入本地缓存，打开聊天秒显。
 *
 * 游标：messages.seq 是全局单调递增主键，客户端把「本轮返回的最大 seq」
 * 作为下一轮 after 传入。
 *  - after=0（首次/游标丢失）：不返回消息体，只返回 conversations 与
 *    serverMaxSeq —— 客户端用它初始化游标，避免首拉全库。
 *  - limit：单轮最多 120 条，超出的下一轮继续（游标已推进，自动续传）。
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const raw = Math.max(0, Number(url.searchParams.get("after") || 0) || 0);
    const conversations = await listWatchConversations(user.id);
    if (raw <= 0) {
      const serverMaxSeq = await maxWatchSeq(user.id);
      return ok({ groups: [], conversations, serverMaxSeq, serverTime: Date.now() });
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 80) || 80, 1), 120);
    const fetched = await listWatchMessagesSince(user.id, raw, limit + 1);
    const hasMore = fetched.length > limit;
    const list = fetched.slice(0, limit);
    const byConv = new Map<string, typeof list>();
    for (const m of list) {
      const arr = byConv.get(m.conversationId);
      if (arr) arr.push(m);
      else byConv.set(m.conversationId, [m]);
    }
    const groups = [...byConv.entries()].map(([conversationId, messages]) => ({ conversationId, messages }));
    return ok({ groups, conversations, hasMore, serverTime: Date.now() });
  } catch (e) {
    // 兜底状态码不能是 401：手表把 401 视为登录失效会直接踢回登录页。
    return fail(e);
  }
}
