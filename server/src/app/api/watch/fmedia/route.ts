import { createHash } from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import { appError } from "@/lib/errors";
import { assertSafeUrl } from "@/lib/ssrf";
import { fail, ok, requireUser } from "@/server/httpUtil";
import { processWatchAudio, processWatchImage, processWatchOriginal, readWatchText } from "@/server/watchMedia";
import type { AttachmentMeta, MessageRow } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 合并转发子消息媒体代理：子消息附件只有 QQ 原始 URL（可能过期/需鉴权），
 * 这里经服务端拉取 + 手表格式加工（图片≤240 / 音频→MP3 / 原图 / 文本）后返回。
 * 用 URL 哈希作伪消息 ID，复用同一套落盘缓存。
 */
function pseudoMessage(userId: string, url: string): MessageRow {
  // 哈希输入带上 userId：不同用户的转发媒体互不串读（缓存目录按 id 隔离）。
  const hash = createHash("sha1").update(`${userId}:${url}`).digest("hex").slice(0, 16);
  return { id: `fwd${hash}`, userId } as MessageRow;
}

function paramsOf(req: Request, body: { url?: string; kind?: string }): { url: string; kind: string; orig: boolean } {
  const url = new URL(req.url);
  return {
    url: body.url || url.searchParams.get("url") || "",
    kind: body.kind || url.searchParams.get("kind") || "",
    orig: url.searchParams.get("orig") === "1",
  };
}

async function handle(req: Request, useQuery: boolean) {
  const user = await requireUser(req);
  const body = useQuery ? {} : ((await req.json().catch(() => ({}))) as { url?: string; kind?: string });
  const { url, kind, orig } = paramsOf(req, body);
  if (!url || !/^https?:\/\//i.test(url)) throw appError("INVALID_REQUEST", "媒体地址无效", "");
  assertSafeUrl(url);
  const message = pseudoMessage(user.id, url);

  // ── 文本（转发子消息里的文本文件）
  if (kind === "text") {
    const att: AttachmentMeta = { url, contentType: "text/plain" };
    const { filename, text } = await readWatchText(att, message, 0);
    return ok({ filename, text, size: text.length });
  }

  const att: AttachmentMeta = { url, contentType: kind === "audio" ? "audio/mpeg" : "image/jpeg" };

  let filePath: string;
  let contentType: string;
  let width = 0;
  let height = 0;
  let size = 0;
  if (kind === "audio") {
    const audio = await processWatchAudio(message, 0, att);
    filePath = audio.path;
    contentType = audio.contentType;
    size = audio.size;
  } else if (orig) {
    // 转发子消息的「查看原图」
    const img = await processWatchOriginal(message, 0, att);
    filePath = img.path;
    contentType = img.contentType;
    width = img.width;
    height = img.height;
    size = img.size;
  } else {
    const img = await processWatchImage(message, 0, att);
    filePath = img.path;
    contentType = img.contentType;
    width = img.width;
    height = img.height;
    size = img.size;
  }

  // meta=1：只返回尺寸等元信息（手表先拿尺寸再决定渲染大小）。
  if (new URL(req.url).searchParams.get("meta") === "1") {
    return ok({ kind: kind === "audio" ? "audio" : "image", width, height, contentType, size });
  }

  const bodyStream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>;
  return new Response(bodyStream, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(fs.statSync(filePath).size),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function POST(req: Request) {
  try {
    return await handle(req, false);
  } catch (e) {
    return fail(e, 404);
  }
}

export async function GET(req: Request) {
  try {
    return await handle(req, true);
  } catch (e) {
    return fail(e, 404);
  }
}
