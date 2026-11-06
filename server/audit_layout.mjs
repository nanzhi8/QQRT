/**
 * 布局审计：找出两类真机 UI 缺陷
 *
 *  1. 高度溢出 —— 240×240 屏上 header + 主体 > 240，底部被裁掉（bug#3「少一截」）
 *  2. 未绘制区域 —— 容器没有显式 backgroundColor。真机上未绘制的区域渲染为
 *     **纯黑**，这就是「大黑块」（bug#3 的另一半）。
 *
 * 官方依据：真机 justify-content/align-items 默认 flex-start（模拟器 center），
 * 因此还额外检查「有 alignItems/justifyContent 期望但未显式声明」的情况。
 */
import fs from "node:fs";
import path from "node:path";

const WATCH = process.argv[2] || "watch";
const PAGES = fs
  .readdirSync(WATCH, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(WATCH, d.name, "index.js")))
  .map((d) => d.name)
  .sort();

const PAGE = 240;

/** 解析 style 对象里某个 class 的声明块 */
function clsBlock(styleSrc, cls) {
  const re = new RegExp(`"\\${cls}":\\s*\\{`);
  const m = styleSrc.match(re);
  if (!m) return null;
  // 从 { 开始配对到同名深度结束
  let i = styleSrc.indexOf("{", m.index);
  let depth = 0;
  for (let j = i; j < styleSrc.length; j++) {
    if (styleSrc[j] === "{") depth++;
    else if (styleSrc[j] === "}") {
      depth--;
      if (depth === 0) return styleSrc.slice(i + 1, j);
    }
  }
  return null;
}

const numProp = (block, prop) => {
  if (!block) return null;
  const m = block.match(new RegExp(`(?:^|[,{\\s])"?${prop}"?:\\s*"?(\\d+)(?:px)?"?`));
  return m ? Number(m[1]) : null;
};
const hasProp = (block, prop) => !!block && new RegExp(`"?${prop}"?:`).test(block);

const pages = [];
let problems = 0;

for (const p of PAGES) {
  const src = fs.readFileSync(path.join(WATCH, p, "index.js"), "utf8");
  const sm = src.match(/var style = \{([\s\S]*?)\n      \};/) || src.match(/var style = \{([\s\S]*?)\n\s*\};/);
  if (!sm) {
    pages.push({ page: p, notes: ["NO_STYLE"], bad: 1 });
    problems++;
    continue;
  }
  const S = sm[1];
  const notes = [];
  let bad = 0;

  const pageBlock = clsBlock(S, ".page");
  const pageH = numProp(pageBlock, "height");
  const pageW = numProp(pageBlock, "width");

  // 1. page 必须正好 240×240
  if (pageH !== PAGE) { notes.push(`page height=${pageH ?? "?"} ≠ 240`); bad++; }
  if (pageW !== PAGE) { notes.push(`page width=${pageW ?? "?"} ≠ 240`); bad++; }
  if (!hasProp(pageBlock, "backgroundColor")) { notes.push("page 无 backgroundColor（真机会黑屏）"); bad++; }

  // 2. 纵向主体高度不得超过 240
  const headerH = numProp(clsBlock(S, ".header"), "height");
  for (const mainCls of [".list", ".body", ".main"]) {
    const mb = clsBlock(S, mainCls);
    if (!mb) continue;
    const mh = numProp(mb, "height");
    if (mh == null) continue;
    const sum = (headerH || 0) + mh;
    if (sum > PAGE) { notes.push(`header(${headerH})+${mainCls}(${mh})=${sum} > 240 溢出`); bad++; }
    // 主体容器必须有底色，否则未绘制部分呈黑色
    if (!hasProp(mb, "backgroundColor")) { notes.push(`${mainCls} 无 backgroundColor（黑块风险）`); bad++; }
  }

  // 3. 列表行如果高度累加可能露底，行容器也要有底色
  for (const cls of [".item-row", ".item-card", ".empty-row", ".row", ".msg-row"]) {
    const b = clsBlock(S, cls);
    if (b && numProp(b, "height") && !hasProp(b, "backgroundColor")) {
      notes.push(`${cls} 有固定高但无 backgroundColor（黑块风险）`);
      bad++;
    }
  }

  // 4. flex 容器若显式声明了 justifyContent/alignItems 期望，必须显式写（真机默认 flex-start）
  //    这里只统计「横向居中容器」是否漏写 justifyContent —— 最常见的中招点
  for (const cls of [".empty-row", ".btn", ".btn-sm", ".btn-ghost", ".btn-small", ".seg-btn", ".avatar", ".badge"]) {
    const b = clsBlock(S, cls);
    if (!b) continue;
    if (hasProp(b, "flexDirection") && /"row"/.test(b) && !hasProp(b, "justifyContent")) {
      notes.push(`${cls} 横向布局未显式 justifyContent`);
      bad++;
    }
  }

  // 5. 禁用选择器检查（官方：不支持 id 选择器与父子级联选择器）
  for (const m of S.matchAll(/"([^"]+)":\s*\{/g)) {
    const sel = m[1];
    if (sel.startsWith("#")) { notes.push(`使用了 id 选择器 ${sel}`); bad++; }
    if (sel.includes(">") || (sel.includes(" ") && !sel.includes(":"))) { notes.push(`使用了级联选择器 ${sel}`); bad++; }
  }

  problems += bad;
  pages.push({ page: p, pageH, headerH, notes, bad });
}

console.log("page".padEnd(11), "W×H".padEnd(10), "hdr", "主体", "结论");
for (const r of pages) {
  const wh = r.pageH != null ? `240×${r.pageH}` : "?";
  console.log(
    r.page.padEnd(11),
    wh.padEnd(10),
    String(r.headerH ?? "-").padEnd(4),
    "    ",
    r.bad === 0 ? "✓" : `✗ ${r.notes.join("；")}`,
  );
}

console.log(
  problems === 0
    ? "\n==== 布局审计：全部通过 ✓ ===="
    : `\n==== 布局审计：${problems} 处问题 ✗ ====`,
);
process.exit(problems === 0 ? 0 : 1);
