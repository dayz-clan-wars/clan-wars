import type { Database } from "@factions/db";
import { boosterKits, discordBoosters, factionMembers, factions, identityLinks } from "@factions/db";
import { KIT_SLOTS, isAllowed, type KitSlot } from "@factions/domain";
import { boosterCatalogue } from "@factions/domain/catalogue";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { generateBoosterKits, type BoosterKit } from "./booster-kits.js";
import { syncProjection, BOOSTER_KIT_STORE, type ProjectionUploader, type ProjectionDrift } from "./projection-upload.js";

/**
 * The committed catalogue, parsed ONCE at startup — the same treatment
 * main.ts gives the two spawner templates, and for the same reason: a
 * malformed catalogue must stop the worker here, loudly, rather than throwing
 * on every sweep forever.
 *
 * ⚠️ The path to the asset lives in `@factions/domain`, beside the file it
 * names, and is reached here through `boosterCatalogue()`. A cross-package
 * relative path from this file would keep typechecking after the asset moved
 * and crash the worker at startup instead.
 *
 * ⚠️ `boosterCatalogue()` is lazy and memoised; calling it HERE, at module
 * scope, is what keeps the "loudly, at startup" promise above. Moving this
 * call inside the tick would defer a malformed catalogue to the first sweep.
 */
const CATALOGUE = boosterCatalogue();

export type BoosterKitTickResult = { kits: number; uploaded: boolean };

/**
 * Mirror every eligible booster's kit into its own spawner file.
 *
 * ⚠️ A PROJECTION, not a side effect of boosting or of placing a kit. The
 * file is regenerated in full every pass and uploaded only when it differs
 * from the last successful upload. That is what makes a failed upload
 * self-healing (the hash does not advance, so the next tick retries) and what
 * makes revocation need no code of its own — a booster who stops boosting,
 * unlinks, or has their catalogue picks retired simply stops appearing in the
 * generated file, and their kit is gone at the next restart.
 */
export async function boosterKitTick(db: Database, deps: {
  serverId: number;
  client: ProjectionUploader;
  remoteDir: string;
  fileName: string;
  now: Date;
  /** Called when the file on the server is not the one we last uploaded. */
  onDrift?: (drift: ProjectionDrift) => void;
}): Promise<BoosterKitTickResult> {
  const rows = await db.select({
    discordId: boosterKits.discordId,
    gamertag: identityLinks.gamertag,
    texture: factions.texture,
    posX: boosterKits.posX, posY: boosterKits.posY, posZ: boosterKits.posZ,
    // ⚠️ These nine keys ARE the `KIT_SLOTS` strings, which is the only thing
    // that makes the `r[slot]` lookup below work. Rename one — or select it
    // under any other alias — and that slot silently never spawns for anyone.
    mask: boosterKits.mask,
    eyewear: boosterKits.eyewear,
    hat: boosterKits.hat,
    jacket: boosterKits.jacket,
    pants: boosterKits.pants,
    boots: boosterKits.boots,
    gloves: boosterKits.gloves,
    hipPack: boosterKits.hipPack,
    backpack: boosterKits.backpack,
  }).from(boosterKits)
    // ⚠️ INNER, and this is the whole of revocation: `discord_boosters` rows
    // are DELETED when someone stops boosting, so the kit leaves the file on
    // the next tick with no revoke path of its own.
    .innerJoin(discordBoosters, eq(discordBoosters.discordId, boosterKits.discordId))
    // ⚠️ INNER as well, and it is where the gamertag comes from: the file
    // stamps each object with the owner's name, and a kit for a character we
    // can no longer name belongs to nobody. Unlinking therefore revokes too.
    .innerJoin(identityLinks, eq(identityLinks.discordId, boosterKits.discordId))
    // LEFT, unlike the two above: a booster in no clan still gets their nine
    // pieces, just no armband. Joined live rather than stored, so a clan
    // change or a rebind corrects itself at the next restart.
    .leftJoin(factionMembers, and(
      eq(factionMembers.dayzId, identityLinks.dayzId),
      eq(factionMembers.serverId, deps.serverId),
      // ⚠️ `full` only — a pending member is on this table and not on the
      // roster (spec §4.5), so flying the clan's armband would be wrong.
      eq(factionMembers.status, "full"),
    ))
    // ⚠️ NO faction-status filter here, while the site's armband read goes
    // through `viewerForDb`, which restricts the clan to HOLDING_STATUSES.
    // The two agree today only because the paths out of a holding status —
    // reservation lapse and disband — DELETE the `faction_members` rows, so
    // this join finds nothing for a clan that has stopped holding. Behaviour
    // is unchanged here deliberately: adding the filter would be a silent
    // divergence from `viewerForDb` in the other direction if that ever
    // stopped deleting. If a future status is ever left with its roster rows
    // intact, this join starts flying that clan's armband on the server while
    // the page shows no armband at all, and THAT is the failure to look for.
    .leftJoin(factions, eq(factions.id, factionMembers.factionId))
    // Placed, or there is nowhere to put the kit. A null coordinate reaching
    // Number() below would be 0, dropping every unplaced kit at the map
    // corner rather than leaving it out.
    .where(and(isNotNull(boosterKits.posX), isNotNull(boosterKits.posY), isNotNull(boosterKits.posZ)))
    // Stable order, or the bytes differ between ticks and we upload forever.
    // Total without a tie-break: `discord_id` is booster_kits' primary key.
    .orderBy(asc(boosterKits.discordId));

  const list: BoosterKit[] = rows
    .map((r) => ({
      discordId: r.discordId,
      gamertag: r.gamertag,
      texture: r.texture,
      // ⚠️ numeric columns arrive as STRINGS from Drizzle. Without Number()
      // the arithmetic in the generator concatenates and every kit lands
      // somewhere absurd. pos_y is altitude, matching `declarations.y` and
      // the spawner's own "pos" slot — nothing is reordered here.
      x: Number(r.posX), y: Number(r.posY), z: Number(r.posZ),
      items: KIT_SLOTS
        .map((slot) => ({ slot, className: r[slot] }))
        .filter((s): s is { slot: KitSlot; className: string } => s.className !== null)
        // A slot holding a class name that has since left the catalogue is
        // skipped, not fatal: a catalogue edit must never be able to stop a
        // kit spawning outright.
        .filter((s) => isAllowed(CATALOGUE, s.slot, s.className))
        .map((s) => s.className),
    }))
    // ⚠️ After catalogue filtering, not before: a kit whose only slot holds a
    // class name that has since left the catalogue has nothing to spawn.
    .filter((k) => k.items.length > 0);

  const content = generateBoosterKits(list);
  const uploaded = await syncProjection(db, {
    serverId: deps.serverId, client: deps.client, remoteDir: deps.remoteDir, fileName: deps.fileName,
    content, now: deps.now, store: BOOSTER_KIT_STORE, onDrift: deps.onDrift,
  });
  return { kits: list.length, uploaded };
}
