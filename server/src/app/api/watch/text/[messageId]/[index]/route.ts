import { appError } from "@/lib/errors";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { getMessage } from "@/server/repo";
import { readWatchText } from "@/server/watchMedia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 手表端查看文本文件（bug#13）。
 *
 * 服务器把文本抽出成纯字符串返回（只读前 20KB，避免撑爆 128MB 内存的手表），
 * 并做 UTF-8 / GBK 编码兜底，保证中文不乱码。
 */
export async function GET(req: Request, { params }: { params: Promise<{ messageId: string; index: string }> }) {
  try {
    const user = await requireUser(req);
    const { messageId, index } = await params;
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0) throw appError("INVALID_REQUEST", "无效的附件序号", "");

    const message = await getMessage(user.id, messageId);
    if (!message) throw appError("INVALID_REQUEST", "消息不存在", "");
    const att = message.attachments[idx];
    if (!att) throw appError("INVALID_REQUEST", "附件不存在", "");

    const { filename, text } = await readWatchText(att, message, idx);
    return ok({ filename, text, size: att.size ?? text.length });
  } catch (e) {
    return fail(e, 404);
  }
}
