import { describe, it, expect } from "vitest";
import * as copy from "../src/index";
import { lapsedCopy } from "../src/index";

/**
 * ⚠️ @factions/copy is read by apps/web AND apps/bot. A Discord timestamp
 * token in a shared string renders as a formatted date in Discord and as
 * literal angle-bracket noise on the website.
 *
 * `discord-time.ts` deliberately lives in this package (the bot imports it
 * from here), so "the package contains no tokens" is NOT the invariant and
 * would be false. The invariant is narrower and is the one that matters:
 * nothing reachable from the COPY TABLES may contain one. A time-bearing
 * shared string takes a pre-formatted argument instead — see `lapsedCopy`.
 *
 * ⚠️ A NAMESPACE import, not a list of names. An enumerated list silently
 * stops covering anything added to the package later — and this guard's
 * entire job is catching a mistake nobody has made yet, so the surface it
 * checks has to grow by itself.
 *
 * `at`/`rel`/`atRel` are excluded BY NAME because they are the token
 * builders: their source necessarily contains `<t:`. That is the one
 * legitimate exception, and naming it here is what keeps it the only one.
 */
const TOKEN_BUILDERS = new Set(["at", "rel", "atRel"]);

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (typeof v === "function") {
    // Not called: a renderer's arguments are surface-specific by design.
    // Its SOURCE is checked instead, which catches a token typed into a
    // template literal — the only way one could get in here.
    out.push(String(v));
  } else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

const SURFACES: Record<string, unknown> = Object.fromEntries(
  Object.entries(copy).filter(([name]) => !TOKEN_BUILDERS.has(name))
);

describe("no Discord tokens in shared copy", () => {
  it.each(Object.keys(SURFACES))("%s contains no <t: token", (name) => {
    const offenders = strings(SURFACES[name]).filter((s) => s.includes("<t:"));
    expect(offenders).toEqual([]);
  });
});

describe("time-bearing shared copy takes a pre-formatted string", () => {
  it("lapsedCopy interpolates whatever the surface formatted", () => {
    expect(lapsedCopy("<t:1790001000:R>")).toContain("<t:1790001000:R>");
    expect(lapsedCopy("21 Sep, 14:30 UTC")).toContain("21 Sep, 14:30 UTC");
  });
});
