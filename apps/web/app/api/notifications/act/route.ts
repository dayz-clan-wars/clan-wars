import type { NextRequest, NextResponse } from "next/server";
import {
  acceptInvite, declineInvite, castVote,
  markNoticeRead, myInvites,
} from "@factions/roster";
import { formAction, id, safeBack, confirmed } from "@/lib/form";
import { code } from "@/lib/clan-copy";
import { leadershipCode } from "@/lib/leadership-copy";
import { gone } from "@/lib/notifications-copy";

/**
 * The actions a notice can carry (spec §5).
 *
 * ⚠️ Every target is resolved from LIVE state, never from the notice's payload.
 * An invite id frozen at write time can be revoked, expired or superseded
 * before the player opens the page, and acting on it would act on something
 * that no longer means what the notice said. Rebind has no act here at all:
 * `rebindCandidatesFor` can return several poles, `clan_notices_no_coordinates`
 * forbids the notice payload from saying which one, and there is nothing to
 * correlate against — so `rebind_proposed`'s button is a link to the picker
 * on `/clan/settings` instead (see notifications/actions.tsx).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/notifications", async (session, form) => {
    const back = safeBack(form.get("back"), "/notifications");
    const noticeId = id(form, "noticeId");
    const act = form.get("act");

    const done = async (resultCode: string): Promise<{ back: string; code: string }> => {
      if (noticeId !== null) await markNoticeRead(session.sub, noticeId);
      return { back, code: resultCode };
    };

    if (act === "accept" || act === "decline") {
      const clanId = id(form, "clanId");
      const invites = await myInvites(session.sub);
      // ⚠️ Matched to the notice's OWN clan, never invites[0]. A player can hold
      // invites from more than one clan; picking the first blindly can accept an
      // invite from a DIFFERENT clan than the one the button was pressed on —
      // joining carries a cooldown and is not cleanly reversible.
      const invite = clanId === null ? undefined : invites.find((i) => i.clanId === clanId);
      // Gone since the page rendered (or the form carried no clan id at all): say so rather than guess.
      if (!invite) return { back, code: gone("invite") };
      if (act === "accept") return done(code("accept", await acceptInvite(session.sub, invite.id)));
      const ok = await declineInvite(session.sub, invite.id);
      return done(code("decline", ok ? "declined" : "gone"));
    }

    // Same gate as /api/clan/cast-vote: casting a no-confidence vote is public and
    // irreversible, so the confirm field (armed by the notice's own ConfirmButton)
    // must be present, not just a click.
    if (act === "vote") {
      if (!confirmed(form)) return done(leadershipCode("cast-vote", "unconfirmed"));
      return done(leadershipCode("cast-vote", await castVote(session.sub)));
    }

    return { back, code: "notice.bad-input" };
  });
}
