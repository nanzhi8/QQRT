// 组装最终交付包
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();               // work/qqbot
const STAGE = path.join(ROOT, '.deliver-stage');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_ZIP = path.join(OUT_DIR, 'QQRT-交付包.zip');

function rm(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function mk(p) { fs.mkdirSync(p, { recursive: true }); }

function copyFile(src, dst) { mk(path.dirname(dst)); fs.copyFileSync(src, dst); }
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

console.log('[1/4] 清理阶段目录…');
rm(STAGE); rm(OUT_DIR);
mk(STAGE);

// ---------- 01 RPK ----------
console.log('[2/4] 组装交付结构…');
// 自动挑选 dist 下版本号最大的 RPK（避免改版本后忘记同步脚本）
const distDir = path.join(ROOT, 'watch/dist');
const rpkFiles = fs.readdirSync(distDir).filter((f) => f.endsWith('.rpk'));
if (!rpkFiles.length) throw new Error('RPK 不存在: ' + distDir);
rpkFiles.sort((a, b) => {
  const na = (a.match(/-v(\d+)\.rpk$/) || [])[1] || 0;
  const nb = (b.match(/-v(\d+)\.rpk$/) || [])[1] || 0;
  return Number(na) - Number(nb);
});
const rpkName = rpkFiles[rpkFiles.length - 1];
const rpkSrc = path.join(distDir, rpkName);
console.log('    使用 RPK:', rpkName);
copyFile(rpkSrc, path.join(STAGE, '01_RPK安装包/' + rpkName));
copyFile(path.join(ROOT, 'docs/RPK签名与安装指引.md'), path.join(STAGE, '01_RPK安装包/RPK签名与安装指引.md'));

copyFile(path.join(ROOT, '交付说明.md'), path.join(STAGE, '交付说明.md'));

// ---------- 03 AI 部署提示词 ----------
copyFile(path.join(ROOT, 'docs/AI部署提示词.md'), path.join(STAGE, '03_AI部署提示词/AI部署提示词.md'));

// ---------- 04 文档 ----------
const DOCS = ['部署教程.md', '功能清单.md', '变更记录.md', '验证报告.md',
  '官方依据_本轮实测.md', '交接提示词.md', 'RPK签名与安装指引.md'];
for (const d of DOCS) {
  const s = path.join(ROOT, 'docs', d);
  if (fs.existsSync(s)) copyFile(s, path.join(STAGE, '04_文档', d));
}

// ---------- 05 测试脚本 ----------
for (const t of ['harness.mjs', 'mediapipe.mjs', 'review.mjs', 'contract.mjs', 'official-api-audit.mjs', 'psql-shim.cjs']) {
  const s = path.join(ROOT, 'docs', t);
  if (fs.existsSync(s)) copyFile(s, path.join(STAGE, '05_测试脚本', t));
}
copyFile(path.join(ROOT, 'audit_layout.mjs'), path.join(STAGE, '05_测试脚本/audit_layout.mjs'));
copyFile(path.join(ROOT, 'scripts/preflight.mjs'), path.join(STAGE, '05_测试脚本/preflight.mjs'));

// ---------- 02 服务端 zip ----------
console.log('[3/4] 打包服务端…');
const SERVER_TMP = path.join(STAGE, '_server-tmp/qqbot-src');
mk(SERVER_TMP);

// ⚠️ 必须按 **相对 ROOT 的完整路径** 判断，不能只按目录名！
// 曾经踩过的坑：SKIP 里写 'watch' 是按名字匹配，把 src/app/api/watch/ 也一起排除了，
// 导致交付包缺失全部 /api/watch/* 路由（部署时表现为"缺 /api/watch 路由"）。
//
// ⚠️ 第二个坑：任何以 `.` 开头的顶层目录都可能是**打包脚本自己的暂存目录**
// （.deliver-stage / .bushu-stage / …）。上一版漏了 `.bushu-stage`，
// 结果它被递归打进服务端 zip，导致体积翻倍、路由重复成 62 个。
// 现在统一规则：**顶层目录名以 '.' 开头的一律排除**（.git/.next/.venv/.workbuddy-ai
// 等本来也不该进包），再加显式白名单兜底。
const SKIP_TOP = new Set(['node_modules', '.next', 'data', 'logs', 'dist', '.git',
  '.deliver-stage', '.bushu-stage', 'watch', 'dist-交付']);
const SKIP_ANY = new Set(['node_modules', '.next', '.git']);
const SKIP_FILE = new Set(['.env', 'tsconfig.tsbuildinfo', 'package-lock.json']);

copyDir(ROOT, SERVER_TMP, (s, e) => {
  const rel = path.relative(ROOT, s).replace(/\\/g, '/');
  const isTopLevel = !rel.includes('/');
  if (e.isDirectory()) {
    // 顶层：显式排除列表
    if (isTopLevel && SKIP_TOP.has(e.name)) return true;
    // 顶层：任何点开头的目录（暂存目录/工具目录）都不进包
    if (isTopLevel && e.name.startsWith('.')) return true;
    // 任意层级都要排除的（依赖/构建缓存）
    if (SKIP_ANY.has(e.name)) return true;
  }
  if (e.isFile() && SKIP_FILE.has(e.name)) return true;
  return false;
});

// 补上 .env.example（上面 SKIP_FILE 只排除了 .env）
copyFile(path.join(ROOT, '.env.example'), path.join(SERVER_TMP, '.env.example'));

// 内存实测脚本（硬指标：RSS ≤250MB），确保一定进包
const memScript = path.join(ROOT, 'deploy/check-memory.sh');
if (fs.existsSync(memScript)) {
  copyFile(memScript, path.join(SERVER_TMP, 'deploy/check-memory.sh'));
  console.log('    已附带 deploy/check-memory.sh');
} else {
  console.warn('    ⚠️ 缺少 deploy/check-memory.sh');
}

// 用 PowerShell 压缩（Windows 自带，无外部依赖）
const serverZip = path.join(STAGE, '02_服务器代码与配置/qqbot-watch-server.zip');
mk(path.dirname(serverZip));
execFileSync('powershell', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${path.join(STAGE, '_server-tmp', 'qqbot-src', '*')}' -DestinationPath '${serverZip}' -Force`
], { stdio: 'inherit' });

// 含 watch 源码的大包（额外一份，方便直接用 IDE 打开手表工程）
const bigTmp = path.join(STAGE, '_big-tmp/qqbot-src-full');
mk(bigTmp);
copyDir(SERVER_TMP, bigTmp, () => false);
copyDir(path.join(ROOT, 'watch'), path.join(bigTmp, 'watch'), (s, e) => {
  if (e.isDirectory() && e.name === 'dist') return true;
  return false;
});
const bigZip = path.join(STAGE, '02_服务器代码与配置/大包_含Watch源码/qqbot-watch-server-with-watch.zip');
mk(path.dirname(bigZip));
execFileSync('powershell', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${path.join(STAGE, '_big-tmp', 'qqbot-src-full', '*')}' -DestinationPath '${bigZip}' -Force`
], { stdio: 'inherit' });

rm(path.join(STAGE, '_server-tmp'));
rm(path.join(STAGE, '_big-tmp'));

// ---------- 打包整个交付包 ----------
console.log('[4/4] 生成最终交付 zip…');
mk(OUT_DIR);
execFileSync('powershell', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${path.join(STAGE, '*')}' -DestinationPath '${OUT_ZIP}' -Force`
], { stdio: 'inherit' });

rm(STAGE);

const size = fs.statSync(OUT_ZIP).size;
console.log('\n=== 交付包完成 ===');
console.log('路径:', OUT_ZIP);
console.log('大小:', size, 'bytes =', (size / 1024 / 1024).toFixed(2), 'MB');
