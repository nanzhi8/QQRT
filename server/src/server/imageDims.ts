/**
 * 图片尺寸探测（零依赖）
 *
 * 用途：QQ 入站消息的附件里没有宽高，手表端只能用 1:1 方框显示图片，
 * 表情包还好，聊天里发截图/照片就会被压扁。这里在入库后异步把宽高补进
 * attachments，手表端就能按原比例排版。
 *
 * 只读文件头，不做解码；拿不到就返回 null，调用方保持原样。
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** 从文件头解析图片尺寸，支持 PNG / JPEG / GIF / WebP / BMP */
export function parseImageSize(buf: Buffer): ImageSize | null {
  if (!buf || buf.length < 16) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A，IHDR 在 16..24
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // GIF: "GIF8"，宽高在 6..10（小端）
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    if (buf.length < 10) return null;
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // BMP: "BM"，宽高在 18..26（小端，高度可能为负）
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    if (buf.length < 26) return null;
    const width = Math.abs(buf.readInt32LE(18));
    const height = Math.abs(buf.readInt32LE(22));
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // WebP: "RIFF"...."WEBP"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return parseWebp(buf);
  }

  // JPEG: FF D8 开头，往后扫 SOFn 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return parseJpeg(buf);
  }

  return null;
}

function parseWebp(buf: Buffer): ImageSize | null {
  if (buf.length < 30) return null;
  const fourcc = buf.toString("ascii", 12, 16);
  if (fourcc === "VP8 ") {
    // 帧头：3 字节同步码 + 2 字节宽 + 2 字节高（低 14 位）
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fourcc === "VP8L") {
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fourcc === "VP8X") {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

function parseJpeg(buf: Buffer): ImageSize | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    // 填充字节
    if (marker === 0xff) { i += 1; continue; }
    // 无长度字段的标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

/** 远程图片探测：先试 Range 只取头部，服务端不支持 Range 时读流并截断 */
export async function probeRemoteImageSize(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<ImageSize | null> {
  if (!url) return null;
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const timeoutMs = opts.timeoutMs ?? 6000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${maxBytes - 1}` },
      signal: ac.signal,
      redirect: "follow",
    });
    if (!res.ok && res.status !== 206) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct && !ct.startsWith("image/")) return null;
    if (!res.body) return null;

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let size: ImageSize | null = null;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.length;
      // 每读一块就试一次：JPEG 的 SOF 可能很早出现，不必读完
      size = parseImageSize(Buffer.concat(chunks.map((c) => Buffer.from(c)), total));
      if (size) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return size;
      }
    }
    return size;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
