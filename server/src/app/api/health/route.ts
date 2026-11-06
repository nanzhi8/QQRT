import { db } from "@/db";
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
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, ffmpeg: hasFfmpeg() });
  } catch {
    return Response.json({ ok: false, ffmpeg: hasFfmpeg() }, { status: 500 });
  }
}
