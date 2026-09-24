import type { ActiveFlag } from "@factions/domain";

/** Escape a literal for safe interpolation into a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The document with every `<!-- … -->` region replaced by spaces, character for
 * character, so offsets still line up with the original.
 *
 * ⚠️ This is what keeps a commented-out `<event>` from being mistaken for the live
 * one. Commenting an event out is the standard way an admin disables it by hand, so
 * a stale commented `VehicleTruck01` above the real one is a likely input — and
 * matching it would rewrite the comment, report a successful wipe, and change
 * nothing the game reads.
 */
function maskComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length));
}

/**
 * Set `<active>` inside the named `<event>` block, returning the new document and
 * whether anything actually changed.
 *
 * ⚠️ Deliberately a targeted splice rather than a parse-and-reserialize. events.xml
 * belongs to the server operator; a round trip through an XML library reformats the
 * whole file and drops its comments. Everything outside the one `<active>` element
 * comes back byte-identical.
 *
 * Throws — rather than guessing — when the event is missing, appears more than once
 * outside comments, or carries no `<active>` element. Each of those would otherwise
 * be a write that reports success and wipes nothing.
 */
export function setEventActive(
  xml: string,
  eventName: string,
  active: ActiveFlag,
): { xml: string; changed: boolean } {
  const masked = maskComments(xml);
  // `[^>]*` so an event tag carrying extra attributes still matches; the closing
  // quote in the pattern is what stops `VehicleTruck01` matching `VehicleTruck01Covered`.
  const block = new RegExp(`<event\\s+name="${escapeRe(eventName)}"[^>]*>([\\s\\S]*?)</event>`, "g");

  const matches = [...masked.matchAll(block)];
  if (matches.length === 0) throw new Error(`events.xml: no <event name="${eventName}"> block found`);
  if (matches.length > 1) {
    throw new Error(
      `events.xml: <event name="${eventName}"> appears more than once ` +
        `(${matches.length}×) outside comments — ` +
        `refusing to guess which one is live`,
    );
  }

  const m = matches[0]!;
  const body = m[1]!;
  const bodyStart = m.index! + m[0]!.indexOf(body, m[0]!.indexOf(">") + 1);

  // ⚠️ Searched in the MASKED body, so an <active> that is itself commented out is
  // skipped; spliced into the ORIGINAL, so the comment survives untouched.
  const activeRe = /<active>\s*(\d+)\s*<\/active>/;
  const am = activeRe.exec(body);
  // ⚠️ Check for the element BEFORE rewriting: a block with no <active> and a block
  // already at the target both leave the document unchanged, and collapsing them
  // would report "nothing to do" for a malformed file and never wipe.
  if (!am) throw new Error(`events.xml: <event name="${eventName}"> has no <active> element`);

  if (Number(am[1]) === active) return { xml, changed: false };

  const from = bodyStart + am.index;
  const to = from + am[0].length;
  return { xml: xml.slice(0, from) + `<active>${active}</active>` + xml.slice(to), changed: true };
}

/**
 * The live `<active>` of one event — for the King of the Hill snapshot (spec §2.5).
 * Same refusals as `setEventActive`, for the same reason: a guessed value would
 * be restored later as if it were the operator's.
 */
export function readEventActive(xml: string, eventName: string): ActiveFlag {
  const masked = maskComments(xml);
  const block = new RegExp(`<event\\s+name="${escapeRe(eventName)}"[^>]*>([\\s\\S]*?)</event>`, "g");
  const matches = [...masked.matchAll(block)];
  if (matches.length === 0) throw new Error(`events.xml: no <event name="${eventName}"> block found`);
  if (matches.length > 1) throw new Error(`events.xml: <event name="${eventName}"> appears more than once (${matches.length}×) outside comments`);
  const am = /<active>\s*(\d+)\s*<\/active>/.exec(matches[0]![1]!);
  if (!am) throw new Error(`events.xml: <event name="${eventName}"> has no <active> element`);
  return (Number(am[1]) === 1 ? 1 : 0) as ActiveFlag;
}
