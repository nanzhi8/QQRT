import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const watch = path.join(root, 'watch');
const rpk = fs.readdirSync(path.join(watch, 'dist')).filter(x => x.endsWith('.rpk')).sort().at(-1);
const errors = [];
const MAX_FILE = 200 * 1024;
const MAX_RPK = 1024 * 1024;

// 跨平台列出 zip 内文件名（优先 unzip，退回 Node 原生解析 central directory）。
function listZip(file) {
  const buf = fs.readFileSync(file);
  const names = [];
  // 从尾部找 EOCD（0x06054b50）
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const count = buf.readUInt16LE(i + 10);
    const cdOffset = buf.readUInt32LE(i + 16);
    let p = cdOffset;
    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
      p += 46 + nameLen + extraLen + commentLen;
    }
    break;
  }
  return names;
}

for (const dir of ['login','home','chat','media','settings','msgact','members','forward','convo','stickers','cmd','rich','requests','record']) {
  const f = path.join(watch, dir, 'index.js');
  if (!fs.existsSync(f)) errors.push(`缺少页面: ${dir}/index.js`);
  else if (fs.statSync(f).size >= MAX_FILE) errors.push(`页面 >=200KB: ${f}`);
}
if (!rpk) errors.push('没有 RPK');
else if (fs.statSync(path.join(watch, 'dist', rpk)).size >= MAX_RPK) errors.push('RPK >=1MB');
if (fs.existsSync(path.join(watch, 'dist', rpk || ''))) {
  let listing;
  try {
    listing = execFileSync('unzip', ['-l', path.join(watch, 'dist', rpk)], {encoding:'utf8'});
  } catch {
    listing = listZip(path.join(watch, 'dist', rpk)).join('\n');
  }
  if (/\.map\s*$/.test(listing)) errors.push('RPK 包含 .map');
  if (/META-INF\/CERT/.test(listing)) errors.push('RPK 包含伪造/未验证 CERT；正式签名应由官方工具生成');
}
if (!/wait:\s*1/.test(fs.readFileSync(path.join(watch, 'chat', 'index.js'), 'utf8'))) errors.push('聊天页没有长轮询 wait=1');
if (/2500|2\.5/.test(fs.readFileSync(path.join(watch, 'chat', 'index.js'), 'utf8'))) errors.push('聊天页仍存在 2.5 秒轮询');
if (/2500|2\.5/.test(fs.readFileSync(path.join(root, 'src/app/api/watch/messages/route.ts'), 'utf8'))) errors.push('服务器消息路由仍存在 2.5 秒描述');
if (errors.length) {
  console.error('PRECHECK FAIL');
  for (const e of errors) console.error(' - ' + e);
  process.exit(1);
}
console.log('PRECHECK PASS');
console.log('RPK:', rpk, fs.statSync(path.join(watch,'dist',rpk)).size, 'bytes');
