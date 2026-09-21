import { describe, it, expect } from "vitest";
import {
  TABLES, VAULT_TABLES, LEADERSHIP_TABLES,
  DISCORD_OVERRIDES, DISCORD_VAULT_OVERRIDES, DISCORD_LEADERSHIP_OVERRIDES,
  REFUSAL, DECLARE_COPY, RELEASE_COPY, DECLARED_OK, DISBAND_WARNING,
  ISSUE_COPY, ENDED_COPY, UNLINK_COPY, PIN_RESULT_COPY,
  EMPTY_SCOREBOARD, NO_ALPHAS_WEEK, NO_SEASONS, EMPTY_WAR_LOG, ALPHA_BADGE,
  BOARD_LABELS, EMPTY_BOARD, ACHIEVEMENT_CLOSEST, ACHIEVEMENT_NONE, NO_PROFILE,
  VAULT_INTRO, CLAIM_REFUSAL, PIN_ICON_LABELS,
} from "../src/index";

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
 */
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

const SURFACES: Record<string, unknown> = {
  TABLES, VAULT_TABLES, LEADERSHIP_TABLES,
  DISCORD_OVERRIDES, DISCORD_VAULT_OVERRIDES, DISCORD_LEADERSHIP_OVERRIDES,
  REFUSAL, DECLARE_COPY, RELEASE_COPY, DECLARED_OK, DISBAND_WARNING,
  ISSUE_COPY, ENDED_COPY, UNLINK_COPY, PIN_RESULT_COPY,
  EMPTY_SCOREBOARD, NO_ALPHAS_WEEK, NO_SEASONS, EMPTY_WAR_LOG, ALPHA_BADGE,
  BOARD_LABELS, EMPTY_BOARD, ACHIEVEMENT_CLOSEST, ACHIEVEMENT_NONE, NO_PROFILE,
  VAULT_INTRO, CLAIM_REFUSAL, PIN_ICON_LABELS,
};

describe("no Discord tokens in shared copy", () => {
  it.each(Object.keys(SURFACES))("%s contains no <t: token", (name) => {
    const offenders = strings(SURFACES[name]).filter((s) => s.includes("<t:"));
    expect(offenders).toEqual([]);
  });
});
