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

/**
 * `<timestamp> [StateMachine]: Player <gamertag> (dpnid <n> uid <40 hex>) Entering <state>`
 * — the empty-uid form deliberately does not match.
 *
 * ⚠️ The whole LINE is mandatory, not just the middle of it: anchored to the
 * start of a line (`^` + the timestamp, hence the `m` flag), and closed by the
 * ` Entering` the real line always carries. The gamertag is PLAYER-CONTROLLED
 * and is matched BEFORE the structured fields, so without both ends pinned a
 * gamertag containing the literal text `(dpnid <n> uid <40 hex>)` binds an
 * attacker's own line to whatever dpnid/uid pair they typed — and this parser
 * feeds a ban path with no dry-run net, so the victim is banned for a platform
 * they do not play on. Greedy `(.+)` plus the mandatory ` Entering` suffix
 * makes the LAST `(dpnid … uid …)` on the line — the server's own — the one
 * that binds; anything the player typed stays inside the gamertag.
 *
 * ⚠️ The leading `\s*` is NOT slack in the anchor — it is load-bearing. DayZ
 * space-pads a single-digit hour ("  9:55:02.719 …"), so an anchor that
 * demanded a digit at the line start silently ignored every line logged
 * between 00:00 and 09:59 server time: measured against the 37 retained RPTs,
 * 462 of 3899 StateMachine lines and 67 of 566 device lines, and one real
 * player disappeared from the parse entirely. A PC player who only ever
 * connects in those hours would never be recorded as desktop, never banned,
 * and nothing would report a problem. Whitespace is not free text, so this
 * costs the anchor nothing: everything between the line start and the dpnid is
 * still fixed structure.
 */
const STATE_RE = /^\s*[\d:.]+\s+\[StateMachine\]: Player (.+) \(dpnid (\d+) uid ([0-9A-F]{40})\) Entering/gmu;
/** ⚠️ Anchored, and space-padded-hour tolerant, for the same two reasons. */
const DEVICE_RE = /^\s*[\d:.]+\s+LOGINQUEUE\s+: Player (\d+) updated with device type '(\w+)'/gmu;

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
