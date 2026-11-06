import { fail, ok, requireUser } from "@/server/httpUtil";
import { listFriendEvents, listGroupRobotEvents, listJoinRequests } from "@/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手表通知：新好友 / 机器人入群退群 / 入群申请。 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const [friends, groupEvents, joinRequests] = await Promise.all([
      listFriendEvents(user.id),
      listGroupRobotEvents(user.id),
      listJoinRequests(user.id),
    ]);
    return ok({
      friends: friends.slice(0, 30),
      groupEvents: groupEvents.slice(0, 30),
      joinRequests: joinRequests.slice(0, 50),
      pendingCount: joinRequests.filter((r) => r.status === "pending").length,
    });
  } catch (e) {
    // 兜底状态码不能是 401：手表把 401 视为登录失效会直接踢回登录页，
    // 数据库抖动等瞬时错误会因此误判为掉登录。真正的 AUTH_ERROR 由 fail() 内部映射为 401。
    return fail(e);
  }
}
