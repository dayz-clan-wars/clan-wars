import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ⚠️ Spec §10.3, rule four, pinned structurally — like
 * request-time-rendering.test.ts, and for the same reason: neither failure
 * has a runtime signal.
 *
 * `/api/map/state` answers with one clan's live positions. Without
 * `Cache-Control: no-store, private` any shared cache in front of the app may
 * hand the first viewer's response to the next one, with every auth check
 * still "passing" — the response was authorised, it was just replayed. And
 * the subject of that response must be the session alone: the moment the
 * route reads a parameter naming a player or a clan, "am I allowed to see
 * this?" becomes a question the route has to answer rather than one it cannot
 * be asked.
 */
const ROUTE = join(import.meta.dirname, "..", "app", "api", "map", "state", "route.ts");
const text = readFileSync(ROUTE, "utf8");

describe("the map state route", () => {
  it("is a GET — the client polls it", () => {
    expect(text).toMatch(/export async function GET\(/u);
  });

  it("renders at request time", () => {
    expect(text).toMatch(/export const dynamic = "force-dynamic"/u);
  });

  it("declares no-store, private", () => {
    expect(text).toContain('"Cache-Control": "no-store, private"');
  });

  it("⚠️ sends those headers on EVERY response, not just the successful one", () => {
    // A 401 or 403 cached and replayed is a smaller leak than a 200 cached
    // and replayed, but the count is what keeps a fourth response added later
    // from quietly shipping bare.
    const responses = [...text.matchAll(/NextResponse\.json\(/gu)].length;
    const headered = [...text.matchAll(/headers: HEADERS/gu)].length;
    expect(responses).toBeGreaterThan(0);
    expect(headered).toBe(responses);
  });

  it("⚠️ reads no request parameter — the session is the whole subject", () => {
    expect(text).not.toMatch(/searchParams/u);
    expect(text).not.toMatch(/\bparams\b/u);
  });
});

describe("the pin routes", () => {
  const pin = readFileSync(join(import.meta.dirname, "..", "app", "api", "map", "pin", "route.ts"), "utf8");
  const del = readFileSync(join(import.meta.dirname, "..", "app", "api", "map", "pin", "delete", "route.ts"), "utf8");

  it.each([["drop", pin], ["delete", del]])("the %s route is a POST that redirects back to /map", (_name, src) => {
    expect(src).toMatch(/export async function POST\(/u);
    expect(src).toMatch(/status: 303/u);
    expect(src).toContain('"/map"');
  });

  it.each([["drop", pin], ["delete", del]])("the %s route sends an unauthenticated caller to login, not to the package", (_name, src) => {
    expect(src).toContain('"?next=/map"');
  });
});
