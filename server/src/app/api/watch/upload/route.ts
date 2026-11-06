import { fail, ok, requireUser } from "@/server/httpUtil";
import { saveUpload } from "@/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 手表上传图片/语音：multipart 表单（system.request.upload），与网页版同一套
 * 流式落盘逻辑。返回 localId，再调用 /api/watch/send-media 真正发送。
 */
export async function POST(req: Request) {
  try {
    await requireUser(req);
    const saved = await saveUpload(req);
    return ok({
      localId: saved.localId,
      fileName: saved.fileName,
      contentType: saved.contentType,
      size: saved.size,
      kind: saved.kind,
    });
  } catch (e) {
    return fail(e);
  }
}
