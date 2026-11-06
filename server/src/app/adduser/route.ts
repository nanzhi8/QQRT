import { accountsHtml } from "@/server/consoleHtml";

export const dynamic = "force-dynamic";

/** 账号管理页（自包含 HTML，理由同首页）。 */
export async function GET() {
  return new Response(accountsHtml(), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
