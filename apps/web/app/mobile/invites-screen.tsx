"use client";

import s from "./mobile.module.css";
import { INVITES, flagUrl } from "./fixtures";
import { BackLink } from "./back-link";

export function InvitesScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className={s.screenPad}>
      <BackLink onBack={onBack} />

      <div className={s.inviteList}>
        {INVITES.map((i) => (
          <div key={i.name} className={s.inviteCard}>
            <div className={s.inviteBody}>
              <div
                className={`${s.flagTile} ${s.inviteFlag}`}
                style={{ backgroundImage: `url(${flagUrl(i.flag)})` }}
              />
              <div className={s.grow}>
                <div className={`${s.inviteName} ${s.display}`}>{i.name}</div>
                <div className={`${s.inviteMeta} ${s.mono}`}>{i.meta}</div>
                <div className={`${s.inviteExpires} ${s.mono}`}>Expires {i.expires}</div>
              </div>
            </div>
            <div className={s.inviteActions}>
              <button type="button" className={`${s.tap} ${s.accept} ${s.mono}`}>
                Accept
              </button>
              <button type="button" className={`${s.tap} ${s.decline} ${s.mono}`}>
                Decline
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ⚠️ The 3-day bar is the whole cost of accepting, and it is stated
          before the tap rather than in the confirmation after it. */}
      <div className={`${s.footnote} ${s.mono}`} style={{ marginTop: 22 }}>
        Accepting puts you on that roster immediately. Leaving or being kicked bars you
        from joining a faction on this server for 3 days.
      </div>
    </div>
  );
}
