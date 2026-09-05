import { servers, type Database } from "@factions/db";
import { lockDeclarations, releaseTx } from "@factions/declarations";
import { eq } from "drizzle-orm";

/**
 * Release `dayzId`'s solo declaration (if any) on every active server, one
 * transaction per server so a single server's deadlock does not cost every
 * other server its release — mirroring the dormancy tick's per-server
 * `lapseSolos` sweep. Shared by `/unlink`'s `releaseBases` wiring and its
 * DB-backed test, so the transaction body lives in exactly one place.
 */
export async function releaseSoloBasesFor(db: Database, dayzId: string, now: Date): Promise<boolean> {
  let any = false;
  for (const s of await db.select({ id: servers.id }).from(servers).where(eq(servers.active, true))) {
    const released = await db.transaction(async (tx) => {
      await lockDeclarations(tx, s.id);
      return releaseTx(tx, { dayzId, serverId: s.id }, now);
    });
    any = any || released;
  }
  return any;
}
