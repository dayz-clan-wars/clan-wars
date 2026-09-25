export type ReportPhase = "idle" | "armed" | "done";
export type ReportFocus = "confirm" | "press" | "status" | null;

/**
 * Where keyboard focus goes when the report button changes branch (H4).
 *
 * ⚠️ Each branch REPLACES the one before, so the button that was just pressed
 * unmounts and focus falls to <body>. A keyboard user then has 8 s to find
 * "Confirm — press charges" from the top of the page. Every transition
 * names where focus goes instead.
 */
export function reportFocusAfter(prev: ReportPhase, next: ReportPhase): ReportFocus {
  if (prev === next) return null;
  if (next === "armed") return "confirm";
  if (next === "done") return "status";
  return prev === "armed" ? "press" : null;
}
