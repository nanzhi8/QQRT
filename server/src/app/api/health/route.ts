import { db } from "@/db";
import { ensureSchema } from "@/db/bootstrap";
import { sql } from "drizzle-orm";
import { execFileSync } from "node:child_process";

export const dynamic = "force-dynamic";

/** ffmpeg 探测结果缓存：图片缩放、语音转 MP3、视频分段都依赖它 */
let ffmpegOk: boolean | null = null;

function hasFfmpeg(): boolean {
  if (ffmpegOk !== null) return ffmpegOk;
  try {
    // 真的编一帧 32x32 的 PNG：只跑 -version 不能证明编码器可用
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=red:s=32x32",
        "-frames:v", "1", "-f", "image2", "-y",
        process.platform === "win32" ? "NUL" : "/dev/null",
      ],
      { stdio: "ignore", timeout: 8000 },
    );
    ffmpegOk = true;
  } catch {
    ffmpegOk = false;
  }
  return ffmpegOk;
}

export async function GET() {
  try {
    await ensureSchema();
    await db.execute(sql`select 1`);
    // 轻量计数：排查「会话/群聊不见」时能一眼看出数据在不在
    const stats = await db.execute<{ users: number; convs: number; groups: number; msgs: number }>(sql`
      select
        (select count(*)::int from users) as users,
        (select count(*)::int from conversations) as convs,
        (select count(*)::int from conversations where scope = 'group') as groups,
        (select count(*)::int from messages) as msgs
    `);
    const row = (stats.rows?.[0] ?? {}) as { users?: number; convs?: number; groups?: number; msgs?: number };
    return Response.json({
      ok: true,
      ffmpeg: hasFfmpeg(),
      db: {
        users: Number(row.users ?? 0),
        conversations: Number(row.convs ?? 0),
        groups: Number(row.groups ?? 0),
        messages: Number(row.msgs ?? 0),
      },
    });
  } catch {
    return Response.json({ ok: false, ffmpeg: hasFfmpeg() }, { status: 500 });
  }
}
