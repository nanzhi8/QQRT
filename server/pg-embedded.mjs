#!/usr/bin/env node
/**
 * 内嵌 PostgreSQL（PGlite + Postgres 线协议）
 * ------------------------------------------------------------
 * 不安装任何系统组件：PGlite 是编译成 WASM 的 PostgreSQL 16，
 * 这里用 pglite-socket 把它包装成一个真正的 Postgres TCP 服务，
 * 于是 drizzle-kit / node-postgres 都可以照常连 127.0.0.1:5432。
 *
 * 数据落在 ./pgdata，删掉这个目录就是全新库。
 *
 * 用法：node pg-embedded.mjs
 * 环境变量：PGLITE_PORT（默认 5432）、PGLITE_DIR（默认 ./pgdata）、
 *          PGLITE_MAX_CONN（默认 8）
 */
import path from "node:path";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const port = Number(process.env.PGLITE_PORT || 5432);
const dataDir = path.resolve(process.env.PGLITE_DIR || "./pgdata");
const maxConnections = Number(process.env.PGLITE_MAX_CONN || 8);

fs.mkdirSync(dataDir, { recursive: true });

const db = await PGlite.create(dataDir);
const server = new PGLiteSocketServer({
  db,
  port,
  host: "127.0.0.1",
  maxConnections,
});

await server.start();
console.log(`[pglite] listening on 127.0.0.1:${port}  data=${dataDir}  maxConn=${maxConnections}`);

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`[pglite] ${sig} received, shutting down…`);
  try { await server.stop(); } catch {}
  try { await db.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
