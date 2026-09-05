import { NextResponse } from "next/server";
import { currentSession } from "./viewer";
import type { Session } from "./auth/session";

/** Every personal read leaves with this. Nothing here is cacheable by anyone. */
export const NO_STORE = { "Cache-Control": "no-store, private" } as const;

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * The route handlers' gate. The middleware has already refused anonymous
 * requests to /api/link/* and /api/base/*; a null here means the cookie was
 * tampered with or the secret rotated. 401 as JSON, never a redirect — the
 * caller is a fetch() from the page, which reloads on 401.
 */
export async function sessionOr401(): Promise<{ session: Session } | { response: NextResponse }> {
  const session = await currentSession();
  if (!session) return { response: json({ error: "signed-out" }, 401) };
  return { session };
}
