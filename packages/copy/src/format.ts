const DAY = 86_400_000;
const HOUR = 3_600_000;
/**
 * Two clocks (App Review R2, mockup C). `when` is for a deadline or a log
 * entry — expires, closes, resolves, the war log — and carries the clock and
 * "UTC" because the exact minute matters. `ago` is for an observation —
 * seen, asked, joined, rotated, raised — relative under a day and a bare
 * date after, because "3 h ago" is what a player wants and the UTC suffix
 * on every row was noise.
 */
export const when = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
export const days = (ms: number) => `${Math.round(ms / DAY)} day${Math.round(ms / DAY) === 1 ? "" : "s"}`;
export const hours = (ms: number) => `${Math.round(ms / HOUR)} h`;
