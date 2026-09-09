import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Every write on the site is a form POST; a GET that mutates can be fired by
 * any <img> on the internet (see api/auth/logout). The auth routes and the
 * /link status poll are the only GETs.
 */
const API = join(import.meta.dirname, "..", "app", "api");
const routes = readdirSync(API, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith("route.ts")).map((f) => join(API, f));
const GET_ALLOWED = [`${sep}api${sep}auth${sep}`, `${sep}api${sep}link${sep}status${sep}`, `${sep}api${sep}link${sep}search${sep}`, `${sep}api${sep}players${sep}suggest${sep}`, `${sep}api${sep}map${sep}state${sep}`];

describe("api routes", () => {
  it("finds the clan routes", () => {
    expect(routes.some((f) => f.includes(`${sep}api${sep}clan${sep}`))).toBe(true);
  });
  it.each(routes)("%s exports POST unless it is an allowed read", (file) => {
    const text = readFileSync(file, "utf8");
    if (GET_ALLOWED.some((p) => file.includes(p))) return;
    expect(text).toMatch(/export async function POST\(/u);
    expect(text).not.toMatch(/export async function GET\(/u);
  });

  /**
   * The one route that answers JSON instead of a redirect — a vault code
   * must never ride a URL. It still has to leave with `Cache-Control:
   * no-store, private` like every other personal read/write; pinned by
   * requiring the shared `lib/api.ts` helper (`json(`/`NO_STORE`) rather
   * than a hand-rolled `NextResponse.json(...)` or `new Response(...)`,
   * either of which would satisfy a looser check while skipping the header.
   */
  it("/api/vault/reveal sends NO_STORE via lib/api", () => {
    const file = routes.find((f) => f.endsWith(join("vault", "reveal", "route.ts")));
    expect(file).toBeDefined();
    const text = readFileSync(file!, "utf8");
    expect(text).toMatch(/from "@\/lib\/api"/u);
    expect(text).not.toMatch(/NextResponse\.json\(/u);
    expect(text).not.toMatch(/new Response\(/u);
  });
});
