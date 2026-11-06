import { defineConfig } from "drizzle-kit";

/**
 * 数据库用进程内 PGlite（Postgres 方言），dbCredentials.url 指向数据目录。
 * 迁移：npx drizzle-kit push --force
 */
export default defineConfig({
  dialect: "postgresql",
  driver: "pglite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.PGLITE_DIR || "./pgdata",
  },
});
