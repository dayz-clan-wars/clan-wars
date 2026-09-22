import type { Database } from "@factions/db";
import { awardGrants, identityLinks } from "@factions/db";
import { awardClock, inAwardFile, picksComplete } from "@factions/domain";
import { awardsCatalogue } from "@factions/domain/awards";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { generateBoosterKits, type BoosterKit } from "./booster-kits.js";
import { syncProjection, projectionHash, AWARD_STORE, type ProjectionUploader, type ProjectionDrift } from "./projection-upload.js";

/**
 * Parsed ONCE, at module scope — the booster kit tick's rule: a malformed
 * catalogue stops the worker at startup, loudly, not on every sweep.
 */
const AWARDS = awardsCatalogue();

export type AwardTickResult = { awards: number; uploaded: boolean; stamped: number };

/**
 * Mirror every live award into its own spawner file, then start the clock of
 * any grant that file now carries (awards spec §5).
 *
 * ⚠️ A PROJECTION, like the kit file: regenerated in full every pass, uploaded
 * only on a change, and revocation, expiry and a cleared slot need no code of
 * their own — the grant simply stops appearing in the file.
 */
export async function awardTick(db: Database, deps: {
  serverId: number;
  client: ProjectionUploader;
  remoteDir: string;
  fileName: string;
  now: Date;
  onDrift?: (drift: ProjectionDrift) => void;
}): Promise<AwardTickResult> {
  const rows = await db.select({
    id: awardGrants.id, awardKey: awardGrants.awardKey, discordId: awardGrants.discordId, picks: awardGrants.picks,
    posX: awardGrants.posX, posY: awardGrants.posY, posZ: awardGrants.posZ,
    placeBy: awardGrants.placeBy, placedAt: awardGrants.placedAt, liveFrom: awardGrants.liveFrom,
    expiresAt: awardGrants.expiresAt, revokedAt: awardGrants.revokedAt,
    gamertag: identityLinks.gamertag,
  }).from(awardGrants)
    // ⚠️ INNER, as the kit's: the file stamps every object with its owner's
    // name, and an award for a character we can no longer name belongs to
    // nobody. Unlinking stops the spawn; it does not stop the clock.
    .innerJoin(identityLinks, eq(identityLinks.discordId, awardGrants.discordId))
    .where(and(
      isNull(awardGrants.revokedAt),
      isNotNull(awardGrants.posX), isNotNull(awardGrants.posY), isNotNull(awardGrants.posZ),
    ))
    // Stable order, or the bytes differ between sweeps and we upload forever.
    .orderBy(asc(awardGrants.id));

  const included = rows.filter((r) => {
    const def = AWARDS[r.awardKey];
    // ⚠️ Whole award or nothing. A grant whose picks are no longer complete —
    // a slot cleared after placing, or a class name retired from the
    // catalogue — leaves the file entirely rather than spawning part of a
    // prize the winner would read as a bug.
    return def !== undefined && picksComplete(def, r.picks) && inAwardFile(r, deps.now);
  });

  // ⚠️ `generateBoosterKits` with `texture: null`: an award is the kit's shape
  // with no armband — same lift off the ground, same byte-stable rounding,
  // same `enableCEPersistency: 0` that makes it respawn every restart. One
  // generator, so the two files cannot drift in how they place an object.
  const list: BoosterKit[] = included.map((r) => ({
    discordId: r.discordId, gamertag: r.gamertag, texture: null,
    x: Number(r.posX), y: Number(r.posY), z: Number(r.posZ),
    items: Object.keys(AWARDS[r.awardKey]!.slots).map((slot) => r.picks[slot]!),
  }));
  const content = generateBoosterKits(list);

  // A throw here propagates past the stamping below: no upload, no clock.
  const uploaded = await syncProjection(db, {
    serverId: deps.serverId, client: deps.client, remoteDir: deps.remoteDir, fileName: deps.fileName,
    content, now: deps.now, store: AWARD_STORE, onDrift: deps.onDrift,
  });

  // ⚠️ Stamp ONLY when the stored hash is this content's hash — i.e. the file
  // on the server is the one carrying these grants. Level-triggered from the
  // stored upload time, so a stamp that failed last sweep is simply redone.
  const stored = await AWARD_STORE.read(db, deps.serverId);
  let stamped = 0;
  if (stored && stored.contentHash === projectionHash(content)) {
    for (const r of included) {
      if (r.liveFrom !== null) continue;
      const { liveFrom, expiresAt } = awardClock(stored.uploadedAt, AWARDS[r.awardKey]!.durationDays);
      // ⚠️ `live_from IS NULL` in the WHERE: a grant's clock is set once.
      const done = await db.update(awardGrants).set({ liveFrom, expiresAt })
        .where(and(eq(awardGrants.id, r.id), isNull(awardGrants.liveFrom)))
        .returning({ id: awardGrants.id });
      stamped += done.length;
    }
  }
  return { awards: included.length, uploaded, stamped };
}
