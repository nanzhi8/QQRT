import { consoleHtml } from "@/server/consoleHtml";

export const dynamic = "force-dynamic";

/**
 * 控制台首页：直接返回自包含 HTML（CSS/JS 内联）。
 * 不用 React 页面是因为托管反代会拦截不带 sharecode 的 /_next/static 请求，
 * 导致页面只有 HTML、没有脚本。详见 src/server/consoleHtml.ts。
 */
export async function GET() {
  return new Response(consoleHtml(), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
