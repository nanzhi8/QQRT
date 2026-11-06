import { randomUUID } from "node:crypto";
import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sendMedia } from "@/server/botManager";
import { appError } from "@/lib/errors";
import { config, ensureDirs } from "@/lib/config";
import { fail, ok, readJson, requireUser } from "@/server/httpUtil";
import { getCached } from "@/server/media";
import { getSetting, parseConversationId, type Scope } from "@/server/repo";
import { watchMessageJson } from "@/server/watch";
import type { MessageRow } from "@/db/schema";
import type { FavoriteSticker } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手表发送收藏的表情包（优先用本地缓存，失效则重下原图）。 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const { conversationId, stickerId } = await readJson<{ conversationId?: string; stickerId?: string }>(req);
    if (!conversationId || !stickerId) throw appError("INVALID_REQUEST", "缺少会话或表情参数", "请重新选择");
    const parsed = parseConversationId(conversationId);
    if (!parsed) throw appError("INVALID_REQUEST", "会话 ID 无效", "请刷新页面");

    const raw = await getSetting(user.id, "favoriteStickers");
    const stickers = (raw ? JSON.parse(raw) : []) as FavoriteSticker[];
    const sticker = stickers.find((s) => s.id === stickerId);
    if (!sticker) throw appError("INVALID_REQUEST", "收藏的表情不存在", "可能已被删除");

    let localPath: string;
    let fileName: string;
    let contentType: string;
    let size: number;
    const cached = sticker.messageId ? getCached(sticker.messageId, sticker.index ?? 0) : null;
    if (cached) {
      ensureDirs();
      const ext = path.extname(cached.path).toLowerCase() || path.extname(sticker.filename || "").toLowerCase() || ".png";
      localPath = path.join(config.outDir, `${randomUUID()}${ext}`);
      await copyFile(cached.path, localPath);
      fileName = sticker.filename || "表情包";
      contentType = cached.contentType || sticker.contentType || "image/png";
      size = cached.size;
    } else {
      if (!sticker.url) throw appError("INVALID_REQUEST", "表情原图已失效", "请重新收藏");
      ensureDirs();
      const resp = await fetch(sticker.url, { headers: { "User-Agent": "qqbot-watch/1.0" } });
      if (!resp.ok) throw appError("NETWORK_ERROR", "表情图片下载失败", "原图可能已过期，请让对方重新发送");
      const ext = path.extname(sticker.filename || "").toLowerCase();
      const fallbackExt = sticker.contentType?.startsWith("image/png")
        ? ".png"
        : sticker.contentType?.startsWith("image/gif")
          ? ".gif"
          : ".jpg";
      const safeExt = /^\.(png|jpe?g|gif|webp)$/i.test(ext) ? ext : fallbackExt;
      localPath = path.join(config.outDir, `${randomUUID()}${safeExt}`);
      fileName = sticker.filename || `表情包${safeExt}`;
      contentType = sticker.contentType || "image/png";
      const data = Buffer.from(await resp.arrayBuffer());
      size = data.byteLength;
      await writeFile(localPath, data);
    }

    const message = await sendMedia(user.id, parsed.scope as Scope, parsed.peerId, {
      localPath,
      localId: path.basename(localPath, path.extname(localPath)),
      fileName,
      contentType,
      size,
      kind: "image",
    });
    return ok({ message: watchMessageJson(message as unknown as MessageRow) });
  } catch (e) {
    return fail(e);
  }
}
