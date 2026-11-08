import { getSessionUserFromRequest } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { deleteUserCascade } from "@/server/userDelete";
import { appError } from "@/lib/errors";
import { fail, ok, readJson } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const admin = await getSessionUserFromRequest(req);
    if (!admin || admin.username !== "admin") throw appError("AUTH_ERROR", "请先使用管理员账号登录", "");
    const { id } = await readJson<{ id?: string }>(req);
    if (!id) return fail(new Error("缺少用户 ID"), 400);

    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target) return fail(new Error("用户不存在"), 404);
    if (target.username === "admin") return fail(new Error("不能删除管理员"), 400);

    await deleteUserCascade(target.id);
    return ok({ deleted: target.id });
  } catch (e) {
    return fail(e);
  }
}
