"use client";

import s from "./mobile.module.css";

export function MeScreen({ onClaim }: { onClaim: () => void }) {
  return (
    <div style={{ padding: "24px 16px 8px" }}>
      <div className={s.identityCard}>
        <div className={`${s.sectionLabel} ${s.mono}`} style={{ marginBottom: 10 }}>
          Linked character
        </div>
        <div className={`${s.identityName} ${s.display}`}>SubatomicRacer</div>
        <div className={s.identityRow}>
          <div className={`${s.verified} ${s.mono}`}>Verified</div>
          <div className={`${s.linkedSince} ${s.mono}`}>12 Aug 2026</div>
        </div>
      </div>

      <div className={`${s.sectionLabel} ${s.mono}`} style={{ marginBottom: 12 }}>
        Identity
      </div>
      <div className={s.stack} style={{ marginBottom: 24 }}>
        <div className={s.settingRow}>
          <div className={`${s.settingKey} ${s.mono}`}>Discord</div>
          <div className={`${s.settingValue} ${s.mono}`}>subatomic#0</div>
        </div>
        <button type="button" className={`${s.tap} ${s.settingRow}`}>
          <span>
            <span className={`${s.settingDanger} ${s.mono}`}>Unlink character</span>
            {/* The block is stated on the control itself rather than discovered
                on tap — a leader has to hand the faction over first. */}
            <span className={`${s.settingSub} ${s.mono}`} style={{ display: "block" }}>
              Blocked while you lead a faction
            </span>
          </span>
          <span className={`${s.arrow} ${s.mono}`}>→</span>
        </button>
      </div>

      <button
        type="button"
        className={`${s.tap} ${s.panelGold}`}
        onClick={onClaim}
        style={{ marginBottom: 24 }}
      >
        <span className={`${s.panelLabel} ${s.mono}`} style={{ display: "block" }}>
          Found a faction
        </span>
        <span className={`${s.panelHeadingSm} ${s.display}`} style={{ display: "block" }}>
          Claim a flag
        </span>
        <span className={s.panelBody} style={{ display: "block" }}>
          Three linked players, one flagpole, one ceremony. Start the claim here — you
          finish it in game.
        </span>
      </button>

      {/* The thesis, said out loud on the one screen a player is most likely to
          mistake for an account they control. */}
      <div className={`${s.footnote} ${s.mono}`}>
        Nothing on this site can make a faction exist, hold a pole, or lose one. Those are
        earned in game and proved from the server&rsquo;s own logs.
      </div>
    </div>
  );
}
