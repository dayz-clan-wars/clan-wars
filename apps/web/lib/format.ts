const DAY = 86_400_000;
export const when = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
export const days = (ms: number) => `${Math.round(ms / DAY)} day${Math.round(ms / DAY) === 1 ? "" : "s"}`;
