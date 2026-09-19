import type { NoticeRow } from "@factions/roster";

/**
 * The buttons a notice offers.
 *
 * ⚠️ Drawn from the KIND alone. Whether the action is still available is the
 * route's business (it resolves the live target and says "gone" if it is): a
 * page that tried to decide here would need the same live reads per row, on
 * every render, for a button most players never press.
 */
const btn = (tone: "primary" | "ghost") =>
  `flex min-h-[38px] items-center border px-4 font-display text-xs uppercase tracking-[0.06em] ${
    tone === "primary" ? "border-gold bg-gold text-ground hover:bg-gold-hover" : "border-rule-3 text-ink hover:border-ink"}`;

function Act({ row, act, label, tone }: { row: NoticeRow; act: string; label: string; tone: "primary" | "ghost" }) {
  return (
    <form action="/api/notifications/act" method="post">
      <input type="hidden" name="noticeId" value={row.id} />
      <input type="hidden" name="act" value={act} />
      <input type="hidden" name="back" value="/notifications" />
      <button type="submit" className={btn(tone)}>{label}</button>
    </form>
  );
}

export function NoticeActions({ row }: { row: NoticeRow }): React.ReactNode {
  switch (row.kind) {
    case "invited":
      return <><Act row={row} act="accept" label="Accept" tone="primary" /><Act row={row} act="decline" label="Decline" tone="ghost" /></>;
    case "vote_opened":
      return <Act row={row} act="vote" label="Cast your vote" tone="primary" />;
    case "rebind_proposed":
      return <Act row={row} act="rebind" label="Review it" tone="primary" />;
    default:
      return null;
  }
}
