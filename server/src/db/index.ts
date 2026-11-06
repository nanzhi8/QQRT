import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

/**
 * 进程内 Postgres（PGlite = PostgreSQL 18 编译成 WASM）。
 *
 * 为什么不用外部 Postgres：WorkBuddy 托管的沙箱只给一个 HTTP 端口，不提供数据库，
 * 依赖 `pg` + 连接串的项目会被发布预检直接拒绝。PGlite 跑在同一个进程里，
 * 不需要任何外部服务，SQL / 表结构完全不变（仍是 Postgres 方言，jsonb、
 * on conflict、序列都能用）。
 *
 * 数据目录：PGLITE_DIR，默认 ./pgdata。托管环境下重新发布会清空；
 * 想要持久化就把 PGLITE_DIR 指到持久盘，或改回外部 Postgres。
 */
const dataDir = process.env.PGLITE_DIR || "./pgdata";

const globalForDb = globalThis as typeof globalThis & {
  __qqrtPglite?: PGlite;
  __qqrtDb?: ReturnType<typeof drizzle>;
};

/**
 * 必须缓存到 globalThis：Next.js 会为不同路由 bundle 分别实例化模块，
 * 不缓存的话每个 bundle 都会打开一次同一个数据目录 —— PGlite 单进程独占，
 * 第二个实例会直接报锁冲突。
 */
export const client = globalForDb.__qqrtPglite ?? new PGlite(dataDir);
export const db = globalForDb.__qqrtDb ?? drizzle(client);

if (!globalForDb.__qqrtPglite) {
  globalForDb.__qqrtPglite = client;
  globalForDb.__qqrtDb = db;
}
