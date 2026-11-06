import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ok } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await db.select({ id: users.id }).from(users).where(eq(users.username, "admin")).limit(1);
  return ok({ initialized: admin.length > 0, adminUsername: "admin" });
}
