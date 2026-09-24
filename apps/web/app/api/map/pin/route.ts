import { NextResponse, type NextRequest } from "next/server";
import { dropPin } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { siteUrl } from "@/lib/auth/site-url";
import { gridRefKey } from "@/lib/map-projection";
import { pinResultPath } from "@/lib/map-url";

/**
 * POST from the pin form on /map. Every rule — full member, six icons, the
 * note length, the world's edge — is the package's.
 *
 * ⚠️ `x`/`z` are not validated here on purpose. A non-numeric field becomes
 * `NaN`, reaches `dropPin`, and is refused as `off-map` by `inWorld`'s
 * `Number.isFinite` — one rule, in one place, rather than a second copy of
 * the world's bounds that can drift from it.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const origin = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const session = await currentSession();
  if (!session) return NextResponse.redirect(siteUrl(origin, "/login", "?next=/map"), { status: 303 });
  const form = await req.formData();
  const x = Number(form.get("x"));
  const z = Number(form.get("z"));
  const icon = String(form.get("icon") ?? "");
  const rawNote = form.get("note");
  // Sliced only to bound what crosses the wire; the real limit (PIN_NOTE_MAX)
  // is the package's, and a note over it is refused as `bad-note` rather than
  // silently truncated to something the player did not write.
  const note = typeof rawNote === "string" && rawNote.trim() !== "" ? rawNote.slice(0, 1000) : null;
  const out = await dropPin(session.sub, { x, z, icon, note });
  // Back to the pin's own grid square, dropped or refused, rather than the
  // whole world. A non-numeric field is NaN and simply gets no `at`.
  const at = Number.isFinite(x) && Number.isFinite(z) ? gridRefKey(x, z) : null;
  return NextResponse.redirect(siteUrl(origin, "/map", pinResultPath(out.ok ? "dropped" : out.reason, at)), { status: 303 });
}
