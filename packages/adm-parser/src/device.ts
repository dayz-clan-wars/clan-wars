/**
 * The player's platform, from the server's .RPT file.
 *
 * ⚠️ This is the ONLY place the device type appears. It is not in the .ADM
 * files this package otherwise parses, and there is no Nitrado API for it.
 *
 * ⚠️ The device line names a `dpnid` (a per-session network id), NOT the uid
 * we identify players by — and at the instant it is written the uid is still
 * EMPTY on the StateMachine lines above it, filled about two seconds later.
 * So the uid must be resolved through the dpnid across the WHOLE file, never
 * read from the nearest line above.
 */

export type DeviceSighting = { dayzId: string; gamertag: string; device: "console" | "desktop" };

/** `Player <gamertag> (dpnid <n> uid <40 hex>)` — the empty-uid form deliberately does not match. */
const STATE_RE = /\[StateMachine\]: Player (.+?) \(dpnid (\d+) uid ([0-9A-F]{40})\)/gu;
const DEVICE_RE = /LOGINQUEUE\s+: Player (\d+) updated with device type '(\w+)'/gu;

/** ⚠️ Anything not exactly one of these is not a device we act on. See the drop below. */
const KNOWN = new Set(["console", "desktop"]);

export function parseDevices(rpt: string): DeviceSighting[] {
  const byDpnid = new Map<string, { dayzId: string; gamertag: string }>();
  for (const m of rpt.matchAll(STATE_RE)) {
    byDpnid.set(m[2]!, { dayzId: m[3]!, gamertag: m[1]! });
  }

  const out = new Map<string, DeviceSighting>();
  for (const m of rpt.matchAll(DEVICE_RE)) {
    const device = m[2]!;
    // ⚠️ An unrecognised device string is dropped, not defaulted. A future
    // DayZ build naming a third platform must read as "not PC", never as PC.
    if (!KNOWN.has(device)) continue;
    const who = byDpnid.get(m[1]!);
    // ⚠️ Dropped, never guessed: the login began in the previous file, so this
    // file has no line binding the dpnid to a uid. Four of these exist in the
    // retained logs. Not knowing a device must never become a ban.
    if (!who) continue;
    out.set(`${who.dayzId}:${device}`, { ...who, device: device as "console" | "desktop" });
  }
  return [...out.values()];
}
