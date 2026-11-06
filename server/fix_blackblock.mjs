/**
 * 批量修复「黑块」：给容器补显式 backgroundColor。
 *
 * 真机行为：未绘制的区域渲染为纯黑（模拟器不会），所以
 *   .list / .body / .row / .item-card / .item-row 这类大块容器
 * 必须有明确的 backgroundColor，否则用户会看到大片黑色。
 *
 * 规则：容器用页面底色，列表行/卡片用白色。
 */
import fs from "node:fs";
import path from "node:path";

const WATCH = process.argv[2] || "watch";
const PAGES = ["chat", "func", "convo", "forward", "members", "msgact", "record", "requests", "settings", "stickers"];

// 需要补底色的类 → 用哪一档颜色
//   page  = 与 .page 同色（容器底）
//   card  = 白色（内容块）
const RULES = {
  ".list": "page",
  ".body": "page",
  ".main": "page",
  ".row": "card",
  ".item-card": "card",
  ".item-row": "card",
  ".empty-row": "page",
  ".grid": "page",
};

function clsBlock(src, cls) {
  const re = new RegExp(`"\\${cls}":\\s*\\{`);
  const m = src.match(re);
  if (!m) return null;
  const start = src.indexOf("{", m.index);
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return { text: src.slice(start + 1, j), from: start, to: j };
    }
  }
  return null;
}

let total = 0;
for (const p of PAGES) {
  const f = path.join(WATCH, p, "index.js");
  if (!fs.existsSync(f)) continue;
  let src = fs.readFileSync(f, "utf8");

  // 取页面底色
  const pageBlk = clsBlock(src, ".page");
  const pm = pageBlk && pageBlk.text.match(/backgroundColor:\s*"([^"]+)"/);
  const pageColor = pm ? pm[1] : "#f2f4f8";

  let changed = 0;
  // 从后往前替换，避免偏移错乱
  const targets = [];
  for (const cls of Object.keys(RULES)) {
    const b = clsBlock(src, cls);
    if (!b) continue;
    if (/backgroundColor:/.test(b.text)) continue; // 已有底色，跳过
    targets.push({ cls, b });
  }
  targets.sort((a, b) => b.b.from - a.b.from);

  for (const { cls, b } of targets) {
    const color = RULES[cls] === "card" ? "#ffffff" : pageColor;
    const newBlock = `{ width${b.text.startsWith(" width") ? "" : ""}${b.text.startsWith(" ") ? "" : " "}${b.text.trim().startsWith("width") ? "" : ""}`;
    // 直接在块尾追加 backgroundColor
    const trimmed = b.text.replace(/\s*$/, "");
    let inner;
    if (trimmed.endsWith(",")) inner = `${trimmed} backgroundColor: "${color}" `;
    else inner = `${trimmed}, backgroundColor: "${color}" `;
    src = src.slice(0, b.from + 1) + inner + src.slice(b.to);
    changed++;
  }

  if (changed > 0) {
    fs.writeFileSync(f, src);
    console.log(`${p.padEnd(10)} 补底色 ${changed} 处 (${pageColor})`);
    total += changed;
  } else {
    console.log(`${p.padEnd(10)} 无需修改`);
  }
}
console.log(`\n共补 ${total} 处`);
