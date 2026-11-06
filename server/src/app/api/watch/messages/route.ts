import { fail, ok, requireUser } from "@/server/httpUtil";
import { getMessagesByIds, parseConversationId } from "@/server/repo";
import { sendText } from "@/server/botManager";
import { listWatchMessages, markWatchRead, waitForWatchMessages } from "@/server/watch";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 拉取某会话中 seq > after 的消息（升序）。
 * 手表聊天页使用服务端长轮询：有新消息立即返回，无消息最多等待 20 秒。
 * 客户端每次返回后至少等待 3.1 秒再发下一次请求，满足手表框架限制。
 * - after=0：首次加载，顺带标记已读；
 * - read=1：本轮有新消息时顺带标记已读（正在看聊天，不涨未读）；
 * - sync=id1,id2：顺带返回这些消息的最新状态（发送中→已送达/失败实时更新）。
 *
 * vc20（发送合流长轮询——用户实测反馈「发送慢/第二条不显示」的根治）：
 * 手表网络栈串行，独立发送 POST 要等「取消长轮询→通道释放→POST→再拉取」
 * 至少两个往返，弱网/固件取消不彻底时排队最坏等满 waitMs，表现为发送极慢、
 * 第二条发送超时「不显示」。现支持 GET 参数 send=<urlencoded JSON>
 * {text, replyTo?, mentions?}——服务端在开始 hold **之前**先落库发送：
 *  - 落库消息 seq 必 > after，「订阅后立即查库」会把它随本响应的 messages
 *    一并带回 → 客户端一次往返完成「发送+确认+继续等待」，无需独立 POST；
 *  - 发送失败（无机器人/内容为空等）不抛整请求错误，改为响应 sendError
 *    字段（客户端恢复输入框并提示），长轮询照常进行；
 *  - 响应带 sv=2 回显，客户端据此确认服务端支持合流（旧服务端忽略 send
 *    参数且无 sv/无消息返回，客户端一次性回退独立 POST 路径）。
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const conversationId = url.searchParams.get("conversationId") || "";
    const after = Math.max(0, Number(url.searchParams.get("after") || 0) || 0);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50) || 50, 1), 120);
    if (!conversationId) return fail(new Error("缺少会话 ID"), 400);
    const wait = url.searchParams.get("wait") === "1";
    // waitMs：客户端可指定本次长轮询的最长等待（毫秒，3000..20000）。
    const waitMsRaw = Number(url.searchParams.get("waitMs") || 0) || 20_000;
    /* 官方限制是「页面轮询请求的**间隔** 3s 以上」，不是单次 hold 的时长。
     * 真机实测网络 RTT 约 2s：hold 3s + RTT 2s = 实际发起间隔 5.8s，
     * 期间通道被长轮询反复占用，发送 POST 排在后面，实测 6~19s。
     * 因此把 hold 下限放宽到 0.8s：客户端仍按 ≥3s 的间隔发起（间隔不违规），
     * 但通道每 3s 只被占用 1s，发送与接收都能显著变快。 */
    const waitMs = Math.min(Math.max(waitMsRaw, 800), 20_000);
    // vc24 观测点：手表聊天页「不实时刷新」诊断——hold 进入/退出各记一条。
    // 若生产日志只见 enter 不见 exit（或根本没有 enter），即可分辨
    // 「客户端轮询未发出/挂死」vs「服务端 hold 未推回」。

    // vc20：先处理随路发送（在 hold 之前落库，seq 落库后即可被本响应带回）。
    let sendError: string | null = null;
    const sendParam = url.searchParams.get("send") || "";
    if (sendParam) {
      try {
        const parsed = parseConversationId(conversationId);
        if (!parsed) throw new Error("会话 ID 无效");
        const body = JSON.parse(sendParam) as {
          text?: string;
          replyTo?: string | null;
          mentions?: Array<{ openid: string; name?: string | null }>;
        };
        const text = String(body.text ?? "").trim();
        const mentions = Array.isArray(body.mentions) ? body.mentions : [];
        if (!text && mentions.length === 0) throw new Error("消息内容不能为空");
        await sendText(user.id, parsed.scope, parsed.peerId, {
          text,
          replyTo: body.replyTo ?? null,
          mentions,
        });
      } catch (e) {
        // AppError.detail = { message, suggestion, ... }；普通 Error 用 message。
        const d = (e as { detail?: { message?: string } })?.detail;
        sendError =
          (d && d.message) ||
          (e instanceof Error ? e.message : "") ||
          "发送失败";
      }
    }

    // wait=1 时长轮询（含 after=0 的“等第一条消息”场景）；否则直接查一次。
    // vc20：带 send 参数的请求**不 hold**——发送要的是最快确认，落库消息
    // （seq>after）查库立即随响应带回，一次往返完成「发送+确认」；随后客户端
    // 300ms 快速续拉回到 hold 轮询继续收信。若合流请求也 hold，发送确认要
    // 等满 waitMs（无新消息时），发送反而变慢——违背合流初衷。
    // vc19：waitForWatchMessages 返回 { messages, touched }——touched 表示
    // hold 期间该会话发生过 message 事件（含撤回等 seq 不变的状态更新）。
    const waitRes = wait && !sendParam
      ? await waitForWatchMessages(user.id, conversationId, after, limit, waitMs)
      : null;
    const messages = waitRes ? waitRes.messages : await listWatchMessages(user.id, conversationId, after, limit);
    const touched = waitRes ? waitRes.touched : false;
    if (after === 0) {
      await markWatchRead(user.id, conversationId).catch(() => {});
    } else if (url.searchParams.get("read") === "1" && messages.length > 0) {
      await markWatchRead(user.id, conversationId).catch(() => {});
    }
    let syncStates: Array<{ id: string; status: string; error: string | null }> = [];
    const syncParam = url.searchParams.get("sync") || "";
    if (syncParam) {
      const ids = [...new Set(syncParam.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 30);
      if (ids.length > 0) {
        const rows = await getMessagesByIds(user.id, ids).catch(() => []);
        for (const row of rows) {
          syncStates.push({ id: row.id, status: row.status, error: row.error });
        }
      }
    }
    // vc20：sv=2 —— 服务端支持「send 合流」协议版本回显。客户端仅在响应含
    // sv>=2 时信任合流结果；旧服务端无此字段，客户端自动回退独立 POST。
    const sv = sendParam ? 2 : undefined;
    return ok({
      messages,
      after,
      now: Date.now(),
      syncStates,
      touched,
      ...(sendParam ? { sv, sendError } : {}),
    });
  } catch (e) {
    // 注意：不能用 401 作为兜底状态码。手表客户端把 401 当作 AUTH_ERROR，
    // 一旦数据库抖动等瞬时错误返回 401，手表会直接把用户踢回登录页。
    // fail() 内部已经把真正的 AUTH_ERROR 映射为 401，这里用默认 400。
    return fail(e);
  }
}
