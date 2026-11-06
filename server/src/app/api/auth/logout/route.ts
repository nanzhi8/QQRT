import { SESSION_COOKIE, clearSessionCookie, destroySession } from "@/lib/auth";
import { ok } from "@/server/httpUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const tokens = new Set<string>();
  const raw = req.headers.get("cookie") || "";
  const match = raw.split(/;\s*/).find((p) => p.startsWith(`${SESSION_COOKIE}=`));
  if (match) {
    try {
      tokens.add(decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)));
    } catch {
      tokens.add(match.slice(SESSION_COOKIE.length + 1));
    }
  }
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) tokens.add(bearer.trim());
  for (const t of tokens) await destroySession(t);
  return ok({ loggedOut: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}
