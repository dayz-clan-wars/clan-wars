const DAY = 86_400_000;
const HOUR = 3_600_000;
/**
 * `when` is for a deadline or a log entry — expires, closes, resolves, the
 * war log — and carries the clock and "UTC" because the exact minute
 * matters. `days`/`hours` render a duration, not an instant, for copy that
 * names a window rather than a point in time (`days(ROSTER_COOLDOWN_MS)`, a
 * pass lasting `hours(GUEST_PASS_MS)`). `ago` — the second clock this file
 * once also held, for a relative observation like "3 h ago" — stayed behind
 * in `apps/web/lib/format.ts`; the bot has no equivalent surface today.
 */
export const when = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
export const days = (ms: number) => `${Math.round(ms / DAY)} day${Math.round(ms / DAY) === 1 ? "" : "s"}`;
export const hours = (ms: number) => `${Math.round(ms / HOUR)} h`;
