import fs from "node:fs";
import { Readable } from "node:stream";
import { appError } from "@/lib/errors";
import { cacheInbound, getCached, sanitizeName } from "@/server/media";
import { fail, requireUser } from "@/server/httpUtil";
import { getSetting, getMessage } from "@/server/repo";
import { processWatchImage } from "@/server/watchMedia";
import type { AttachmentMeta, MessageRow } from "@/db/schema";
import type { FavoriteSticker } from "../../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * vc23 表情列表图片（服务端代理）：收藏项存的是 QQ CDN 临时直链（带签名，
 * 过期后手表直连必失败，列表只能退化为显示文件名）。本路由改走服务端：
 *  1) 优先 processWatchImage（按 messageId-index 缩放到 240 内 + 结果缓存，
 *     与聊天页看图同一套缓存，体积小加载快）；
 *  2) 无消息体/处理失败 → cacheInbound 拉原 URL 永久存本地再交付；
 *  3) 都失败 → 404（客户端 markBroken 显示文字兜底）。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const raw = await getSetting(user.id, "favoriteStickers");
    const stickers = (raw ? JSON.parse(raw) : []) as FavoriteSticker[];
    const sticker = stickers.find((s) => s.id === id);
    if (!sticker) throw appError("INVALID_REQUEST", "表情不存在", "可能已被删除");

    let filePath = "";
    let contentType = sticker.contentType || "image/png";
    let filename = sanitizeName(sticker.filename || `sticker-${id}`);

    // 1) 缩放缓存路径（与聊天页看图同一缓存）
    if (sticker.messageId) {
      try {
        const message = await getMessage(user.id, sticker.messageId);
        const idx = sticker.index ?? 0;
        const att = message?.attachments[idx];
        if (message && att) {
          const img = await processWatchImage(message, idx, att);
          filePath = img.path;
          contentType = img.contentType;
        }
      } catch {
        /* 落到原图代理 */
      }
    }

    // 2) 原图代理：cacheInbound 永久存本地（messageId 缺失时用 sticker.id 做缓存键）。
    //    vc24 修复：原图**绝不能直接交付**——官方框架单图下载上限 100KB，
    //    429KB 的原图手表端必然下载失败（onerror → 面板退化成文件名占位，
    //    正是「收藏表情显示文件名」的实锤根因）。落地后必须走 processWatchImage
    //    缩放（ensureLocal 命中刚落地的本地文件，不再外网拉取），失败则 404。
    if (!filePath) {
      if (!sticker.url) throw appError("INVALID_REQUEST", "表情原图已失效", "请重新收藏");
      let getToken: (() => Promise<string>) | undefined;
      try {
        const { requireBot } = await import("@/server/botManager");
        getToken = () => requireBot(user.id).api.getToken();
      } catch {
        /* 匿名下载 */
      }
      const cached = await cacheInbound(
        sticker.messageId || sticker.id,
        sticker.messageId ? sticker.index ?? 0 : 0,
        sticker.url,
        sticker.contentType || "image/png",
        getToken,
      );
      // 伪消息体复用 processWatchImage（缓存键 messageId-index 与 cacheInbound 一致，
      // ensureLocal 直接命中刚落地的原图，不产生二次外网请求）。
      const pseudoMsg = {
        id: sticker.messageId || `stk-${sanitizeName(id)}`,
        userId: user.id,
      } as unknown as MessageRow;
      const pseudoAtt: AttachmentMeta = {
        url: sticker.url,
        contentType: cached.contentType || sticker.contentType || "image/png",
        filename: sticker.filename || "sticker",
      };
      const img = await processWatchImage(pseudoMsg, sticker.index ?? 0, pseudoAtt);
      filePath = img.path;
      contentType = img.contentType;
    }

    const body = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fs.statSync(filePath).size),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return fail(e);
  }
}
