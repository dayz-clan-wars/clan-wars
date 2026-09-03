import type { APIEmbed } from "discord.js";
import type { FactionEventKind } from "@factions/domain";
import type { QueuedFactionEvent, FeedPayload } from "./feed-store.js";

/**
 * Where a flag's artwork lives, if it lives anywhere.
 *
 * ⚠️ Defaulted to null, and that is deliberate: the 33 textures are strings
 * in `packages/domain/src/flags.ts` and no images of them exist anywhere in
 * this repository. Sourcing, licensing and hosting them is its own piece of
 * work the feed does not need. This hook is so adding them later is one
 * function rather than a rewrite.
 */
export type FlagImageResolver = (texture: string) => string | null;

const NO_IMAGE: FlagImageResolver = () => null;

const GREEN = 0x3ba55d;
const BLUE = 0x5865f2;
const AMBER = 0xe67e22;
const RED = 0xed4245;

const COLOR: Record<FactionEventKind, number> = {
  founded: GREEN, activated: GREEN, revived: GREEN,
  renamed: BLUE, rebound: BLUE,
  dormant: AMBER,
  disbanded: RED,
};

/** `Flag_Wolf` → `Wolf`. The player-facing name of the identity. */
export function flagLabel(texture: string): string {
  return texture.replace(/^Flag_/u, "");
}

/** `by SomePlayer`, or nothing at all when the actor is unknown. */
function by(actor: string | undefined): string {
  return actor ? ` by **${actor}**` : "";
}

/** The plain "gone dormant" sentence, with no deadline clause. */
const DORMANT_SENTENCE = "Gone dormant — the flag has not been raised, and supplies are cut.";

function describe(kind: FactionEventKind, p: FeedPayload): string {
  switch (kind) {
    case "founded":
      return `Founded${by(p.actor)}. The ritual is complete — the flag is reserved.`;
    case "activated":
      return `Colors raised${by(p.actor)}. The faction is live.`;
    case "renamed":
      // previousName is written by the rename writer for every `renamed` row.
      // The `?? "its former name"` arm exists only so a hand-inserted or
      // backfilled row cannot render the literal "undefined" to a channel.
      return `Now flying as **${p.name}** — formerly **${p.previousName ?? "its former name"}**.`;
    case "rebound":
      // ⚠️ Never says where from or to. That is the pole invariant, and it is
      // the reason this line is this vague on purpose.
      return `Moved its base${by(p.actor)}.`;
    case "dormant": {
      if (!p.disbandAt) return DORMANT_SENTENCE;
      // ⚠️ payload comes back through an unvalidated cast off a jsonb column,
      // so disbandAt is only an ISO string by convention. A malformed value
      // must degrade to the plain sentence, never post `<t:NaN:R>` — visible
      // garbage in a public channel, permanently, since nothing reposts.
      const ms = Date.parse(p.disbandAt);
      if (!Number.isFinite(ms)) return DORMANT_SENTENCE;
      return `${DORMANT_SENTENCE} ` +
        `The flag, tag and pole return to the pool <t:${Math.floor(ms / 1000)}:R>.`;
    }
    case "revived":
      // No actor: the dormancy clock sees a raise through a max(occurred_at)
      // subquery and never learns who made it. See the spec's §2.
      return "Active again — the flag is flying and supplies resume at the next restart.";
    case "disbanded":
      return "Disbanded. Its flag, tag and pole return to the pool.";
  }
}

/**
 * One transition, one embed. Pure — no client, no I/O, no clock.
 *
 * ⚠️ Reads named payload fields only, never spreads the payload. Combined
 * with `faction_events_no_coordinates`, that is two independent reasons a
 * coordinate cannot reach a channel.
 */
export function feedEmbed(e: QueuedFactionEvent, flagImage: FlagImageResolver = NO_IMAGE): APIEmbed {
  const p = e.payload;
  const image = flagImage(p.texture);

  return {
    title: `${p.name} [${p.tag}]`,
    description: describe(e.kind, p),
    color: COLOR[e.kind],
    fields: [{ name: "Flag", value: flagLabel(p.texture), inline: true }],
    // ⚠️ The transition's time, not the post's. A backfilled founding then
    // renders as history with no special-casing anywhere in the tick.
    timestamp: e.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
  };
}
