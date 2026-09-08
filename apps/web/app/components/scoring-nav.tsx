import { SegNav } from "./ui";

/** The three scoring pages, as one segmented nav; `current` is the page rendering it. */
export function ScoringNav({ current }: { current: "/scoreboard" | "/alphas" | "/seasons" }) {
  return (
    <SegNav label="Scoring pages" items={[
      { label: "Scoreboard", href: "/scoreboard", current: current === "/scoreboard" },
      { label: "Alphas", href: "/alphas", current: current === "/alphas" },
      { label: "Seasons", href: "/seasons", current: current === "/seasons" },
    ]} />
  );
}
