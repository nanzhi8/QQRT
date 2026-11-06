import { ok } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 连通性测试：手表设置页更换服务器地址后用它确认服务可达，无需登录。 */
export async function GET() {
  return ok({ name: "qqbot-watch-server", time: Date.now(), version: 1 });
}
