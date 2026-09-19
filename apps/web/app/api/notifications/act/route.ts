import type { NextRequest, NextResponse } from "next/server";
import {
  acceptInvite, declineInvite, castVote, confirmRebind,
  markNoticeRead, myInvites, clanFor,
} from "@factions/roster";
import { formAction, id, safeBack } from "@/lib/form";
import { code } from "@/lib/clan-copy";
import { leadershipCode } from "@/lib/leadership-copy";
import { gone } from "@/lib/notifications-copy";

/**
 * The three actions a notice can carry (spec §5).
 *
 * ⚠️ Every target is resolved from LIVE state, never from the notice's payload.
 * An invite id frozen at write time can be revoked, expired or superseded
 * before the player opens the page, and acting on it would act on something
 * that no longer means what the notice said. For rebind it is forced anyway:
 * clan_notices_no_coordinates forbids the pole key from ever being stored.
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
      const invites = await myInvites(session.sub);
      const invite = invites[0];
      // Gone since the page rendered: say so rather than fail.
      if (!invite) return { back, code: gone("invite") };
      if (act === "accept") return done(code("accept", await acceptInvite(session.sub, invite.id)));
      const ok = await declineInvite(session.sub, invite.id);
      return done(code("decline", ok ? "declined" : "gone"));
    }

    if (act === "vote") return done(leadershipCode("cast-vote", await castVote(session.sub)));

    if (act === "rebind") {
      const clan = await clanFor(session.sub);
      if (typeof clan === "string") return { back, code: gone("rebind") };
      const candidate = clan.rebindCandidates[0];
      if (!candidate) return { back, code: gone("rebind") };
      return done(code("rebind", await confirmRebind(session.sub, candidate.poleKey)));
    }

    return { back, code: "notice.bad-input" };
  });
}
