import { appError } from "@/lib/errors";
import { fail, ok, readJson, requireUser } from "@/server/httpUtil";
import { getMessage, getSetting, setSetting } from "@/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface FavoriteSticker {
  id: string;
  kind: "image";
  title: string;
  url: string;
  messageId?: string;
  index?: number;
  contentType: string;
  filename?: string;
  size?: number;
  width?: number;
  height?: number;
  createdAt: number;
}

const SETTING_KEY = "favoriteStickers";
const MAX_FAVORITES = 200;

// bug#20：历史入库的图片消息 content_type 可能是 application/octet-stream
// （QQ 官方附件字段缺失所致，入库侧已修复为按扩展名推断；这里对存量数据
// 兜底：filename/url 带图片扩展名同样视为图片）。
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|heic)(?:[?#]|$)/i;
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", heic: "image/heic",
};

function looksImage(att: { contentType?: string | null; filename?: string | null; url?: string | null }): boolean {
  if ((att.contentType || "").toLowerCase().startsWith("image/")) return true;
  return IMAGE_EXT_RE.test(`${att.filename || ""} ${att.url || ""}`);
}

function guessImageMime(att: { contentType?: string | null; filename?: string | null; url?: string | null }): string {
  if ((att.contentType || "").toLowerCase().startsWith("image/")) return att.contentType as string;
  const m = `${att.filename || ""} ${att.url || ""}`.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  const mime = m ? EXT_MIME[m[1].toLowerCase()] : undefined;
  return mime || "image/jpeg";
}

async function listFavorites(userId: string): Promise<FavoriteSticker[]> {
  const raw = await getSetting(userId, SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as FavoriteSticker[]) : [];
  } catch {
    return [];
  }
}

async function saveFavorites(userId: string, stickers: FavoriteSticker[]): Promise<void> {
  await setSetting(userId, SETTING_KEY, JSON.stringify(stickers.slice(0, MAX_FAVORITES)));
}

/** 手表收藏表情包：列表 / 收藏图片消息 / 移除收藏。 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    // vc23：列表 url 重写为服务端代理路由——收藏存的 QQ CDN 直链带签名会过期
    // （过期后手表直连失败，列表退化为文件名）。img/[id] 走服务端本地缓存，
    // 表情图从此永不过期；发送（stickers/send）仍读存储里的原链，不受影响。
    const stickers = (await listFavorites(user.id)).map((s) => ({
      ...s,
      url: `/api/watch/stickers/img/${s.id}`,
    }));
    return ok({ stickers });
  } catch (e) {
    // 兜底状态码不能是 401：手表把 401 视为登录失效会直接踢回登录页，
    // 数据库抖动等瞬时错误会因此误判为掉登录。真正的 AUTH_ERROR 由 fail() 内部映射为 401。
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = await readJson<{ action?: string; messageId?: string; index?: number; id?: string }>(req);
    const action = body.action || "add";

    if (action === "delete") {
      if (!body.id) throw appError("INVALID_REQUEST", "缺少表情 ID", "");
      const stickers = await listFavorites(user.id);
      await saveFavorites(
        user.id,
        stickers.filter((s) => s.id !== body.id),
      );
      return ok({ deleted: true });
    }

    if (action === "add") {
      if (!body.messageId) throw appError("INVALID_REQUEST", "缺少消息 ID", "");
      const idx = Number(body.index ?? 0) || 0;
      const message = await getMessage(user.id, body.messageId);
      const att = message?.attachments[idx];
      if (!message || !att || !looksImage(att)) {
        throw appError("INVALID_REQUEST", "只能收藏图片消息", "");
      }
      const stickers = await listFavorites(user.id);
      const normalized: FavoriteSticker = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: "image",
        title: att.filename || "表情包",
        url: att.url || "",
        messageId: message.id,
        index: idx,
        contentType: guessImageMime(att),
        filename: att.filename,
        size: att.size,
        width: att.width,
        height: att.height,
        createdAt: Date.now(),
      };
      const exists = stickers.some((s) => s.messageId === normalized.messageId && s.index === normalized.index);
      if (!exists) stickers.unshift(normalized);
      await saveFavorites(user.id, stickers);
      // vc23：收藏时立即把原图抓到服务端本地缓存——QQ CDN 直链的 rkey 签名
      // 短命（数小时~数天），等表情列表要看图时再拉大概率已 403，列表只能
      // 退化成文件名。此刻 URL 必然活着，抓一次永久保存。失败不阻塞收藏
      // （发送侧 stickers/send 仍有重下兜底）。
      try {
        if (att.url) {
          const { cacheInbound } = await import("@/server/media");
          await cacheInbound(normalized.messageId ?? normalized.id, idx, att.url, normalized.contentType);
        }
      } catch {
        /* 死链收藏由 img 路由 404 + 客户端 markBroken 文字兜底 */
      }
      return ok({ sticker: normalized });
    }

    throw appError("INVALID_REQUEST", "未知操作", "");
  } catch (e) {
    return fail(e);
  }
}
