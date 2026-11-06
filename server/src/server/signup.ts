import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSetting, setSetting } from "./repo";

const KEY = "allowSignup";

async function adminId(): Promise<string | null> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.username, "admin")).limit(1);
  return rows[0]?.id ?? null;
}

/** 自助注册开关，默认开启；管理员可在控制台关掉。 */
export async function isSignupEnabled(): Promise<boolean> {
  const id = await adminId();
  if (!id) return true;
  const v = await getSetting(id, KEY);
  return v !== "off";
}

export async function setSignupEnabled(on: boolean): Promise<void> {
  const id = await adminId();
  if (!id) throw new Error("管理员尚未初始化");
  await setSetting(id, KEY, on ? "on" : "off");
}
