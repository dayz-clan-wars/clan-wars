import type { NoticeRow } from "@factions/roster";
import { ConfirmButton, SubmitButton } from "@/app/components/ui";

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

/**
 * Casting a no-confidence vote is public and irreversible, and a notice row
 * is a place a misclick is MORE likely than the clan page, not less — same
 * two-mechanism guard as `/clan`'s "Vote yes" (page.tsx): the hidden
 * `confirm=yes` field satisfies the route's `confirmed(form)` check, and
 * `ConfirmButton` is the actual guard (arm on first press, submit on the
 * second within its window). Neither one alone is the point.
 */
function VoteAct({ row }: { row: NoticeRow }) {
  return (
    <form action="/api/notifications/act" method="post">
      <input type="hidden" name="noticeId" value={row.id} />
      <input type="hidden" name="act" value="vote" />
      <input type="hidden" name="back" value="/notifications" />
      <input type="hidden" name="confirm" value="yes" />
      <ConfirmButton confirm="Press again to vote" className={btn("primary")}>Cast your vote</ConfirmButton>
    </form>
  );
}

/**
 * Accept/decline, plus the notice's own clan id so the route can pick the
 * matching invite out of `myInvites` rather than an arbitrary one.
 *
 * ⚠️ A player can hold invites from more than one clan. Without this field the
 * route has no way to tell which invite this button means, and guessing
 * (`invites[0]`) risks joining the wrong clan — not cleanly reversible.
 */
function InviteAct({ row, act, label, tone }: { row: NoticeRow; act: "accept" | "decline"; label: string; tone: "primary" | "ghost" }) {
  return (
    <form action="/api/notifications/act" method="post">
      <input type="hidden" name="noticeId" value={row.id} />
      <input type="hidden" name="act" value={act} />
      <input type="hidden" name="back" value="/notifications" />
      {row.clanId !== null && <input type="hidden" name="clanId" value={row.clanId} />}
      <SubmitButton className={btn(tone)}>{label}</SubmitButton>
    </form>
  );
}

/**
 * `rebindCandidatesFor` can return several poles, and `clan_notices_no_coordinates`
 * forbids the notice payload from carrying a pole key, so nothing here can say which
 * one this notice meant. A link to the picker on `/clan/settings` lets the leader
 * choose, rather than a POST silently committing to `rebindCandidates[0]`.
 */
function RebindAct(): React.ReactNode {
  return (
    // ⚠️ A link, not a POST, so it never calls `markNoticeRead` — the notice stays
    // unread until the leader marks it (or "Mark all read") rather than the instant
    // they follow it, since following the link is not yet acting on it.
    <a href="/clan/settings" className={btn("primary")}>Review it</a>
  );
}

export function NoticeActions({ row }: { row: NoticeRow }): React.ReactNode {
  switch (row.kind) {
    case "invited":
      return <><InviteAct row={row} act="accept" label="Accept" tone="primary" /><InviteAct row={row} act="decline" label="Decline" tone="ghost" /></>;
    case "vote_opened":
      return <VoteAct row={row} />;
    case "rebind_proposed":
      return <RebindAct />;
    default:
      return null;
  }
}
