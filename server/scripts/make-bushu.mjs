// 生成「给 AI 直接部署用」的精简包（bushu.zip）
// 目的：只放部署必需的东西，避免上一位 AI 误用了缺路由的旧包。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const STAGE = path.join(ROOT, '.bushu-stage');
const OUT = path.join(ROOT, 'dist', 'bushu.zip');

function rm(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function mk(p) { fs.mkdirSync(p, { recursive: true }); }
function copyFile(s, d) { mk(path.dirname(d)); fs.copyFileSync(s, d); }
function copyDir(src, dst, skip = () => false) {
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (skip(s, e)) continue;
    if (e.isDirectory()) n += copyDir(s, d, skip);
    else { copyFile(s, d); n++; }
  }
  return n;
}

rm(STAGE); mk(STAGE);

// 1) 服务端源码 zip（顶层排除，不按目录名排除！）
const SRV = path.join(STAGE, 'bushu/_server/qqbot-src');
mk(SRV);
// ⚠️ 只看**相对 ROOT 的完整路径**，不能只按目录名（'watch' 会误伤 src/app/api/watch/）。
// ⚠️ 且顶层任何以 '.' 开头的目录都是打包脚本暂存目录，一律排除——
//    否则 .bushu-stage 会把自己递归打进 zip（体积翻倍、路由重复）。
const SKIP_TOP = new Set(['node_modules', '.next', 'data', 'logs', 'dist', '.git',
  '.deliver-stage', '.bushu-stage', 'watch', 'dist-交付']);
const SKIP_ANY = new Set(['node_modules', '.next', '.git']);
const SKIP_FILE = new Set(['.env', 'tsconfig.tsbuildinfo', 'package-lock.json']);

copyDir(ROOT, SRV, (s, e) => {
  const rel = path.relative(ROOT, s).replace(/\\/g, '/');
  const isTopLevel = !rel.includes('/');
  if (e.isDirectory()) {
    if (isTopLevel && SKIP_TOP.has(e.name)) return true;
    if (isTopLevel && e.name.startsWith('.')) return true;
    if (SKIP_ANY.has(e.name)) return true;
  }
  if (e.isFile() && SKIP_FILE.has(e.name)) return true;
  return false;
});
copyFile(path.join(ROOT, '.env.example'), path.join(SRV, '.env.example'));
copyFile(path.join(ROOT, 'deploy/check-memory.sh'), path.join(SRV, 'deploy/check-memory.sh'));

const srvZip = path.join(STAGE, 'bushu/qqbot-watch-server.zip');
execFileSync('powershell', ['-NoProfile', '-Command',
  `$ProgressPreference='SilentlyContinue'; Compress-Archive -Path '${SRV}/*' -DestinationPath '${srvZip}' -Force`
], { stdio: 'inherit' });
rm(path.join(STAGE, 'bushu/_server'));

// 2) AI 部署提示词
copyFile(path.join(ROOT, 'docs/AI部署提示词.md'), path.join(STAGE, 'bushu/AI部署提示词.md'));
copyFile(path.join(ROOT, '交付说明.md'), path.join(STAGE, 'bushu/交付说明.md'));

// 3) 测试脚本
for (const t of ['harness.mjs', 'mediapipe.mjs', 'review.mjs', 'contract.mjs', 'official-api-audit.mjs', 'psql-shim.cjs']) {
  copyFile(path.join(ROOT, 'docs', t), path.join(STAGE, 'bushu/05_测试脚本', t));
}
copyFile(path.join(ROOT, 'audit_layout.mjs'), path.join(STAGE, 'bushu/05_测试脚本/audit_layout.mjs'));
copyFile(path.join(ROOT, 'scripts/preflight.mjs'), path.join(STAGE, 'bushu/05_测试脚本/preflight.mjs'));

// 4) RPK + 签名指引
const distDir = path.join(ROOT, 'watch/dist');
const rpks = fs.readdirSync(distDir).filter((f) => f.endsWith('.rpk'))
  .sort((a, b) => (Number((a.match(/-v(\d+)\.rpk$/) || [])[1] || 0)) - (Number((b.match(/-v(\d+)\.rpk$/) || [])[1] || 0)));
copyFile(path.join(distDir, rpks[rpks.length - 1]), path.join(STAGE, 'bushu/01_RPK安装包', rpks[rpks.length - 1]));
copyFile(path.join(ROOT, 'docs/RPK签名与安装指引.md'), path.join(STAGE, 'bushu/01_RPK安装包/RPK签名与安装指引.md'));

mk(path.dirname(OUT));
execFileSync('powershell', ['-NoProfile', '-Command',
  `$ProgressPreference='SilentlyContinue'; Compress-Archive -Path '${STAGE}/bushu' -DestinationPath '${OUT}' -Force`
], { stdio: 'inherit' });
rm(STAGE);

const size = fs.statSync(OUT).size;
console.log('bushu.zip 完成:', OUT, size, 'bytes');
