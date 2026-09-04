"use client";

import s from "./mobile.module.css";
import { BackLink } from "./back-link";

export function RebindScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className={s.screenPad}>
      <BackLink onBack={onBack} />

      <div className={`${s.rebindTitle} ${s.display}`}>Move the base</div>
      <div className={s.rebindLead}>
        One free pole is flying <strong>Flag_Wolf</strong>, raised in the last hour by a
        member of your roster.
      </div>

      <div className={s.candidate}>
        <div className={`${s.candidateLabel} ${s.mono}`}>Candidate pole</div>
        <div className={`${s.candidateName} ${s.display}`}>Near Sitnik</div>
        <div className={`${s.candidateMeta} ${s.mono}`}>
          Raised by <strong>Kestrel_44</strong> · 22 minutes ago
        </div>
      </div>

      <div className={s.stack} style={{ marginBottom: 24 }}>
        {/*
          ⚠️ "stays private for 3 days" is vacuously true today — nothing
          publishes base coordinates yet — and becomes a real promise the day
          base declaration ships. See
          docs/superpowers/specs/2026-09-03-base-declaration-design.md.
        */}
        <div className={`${s.terms} ${s.mono}`}>
          Your old base stays private for <strong>3 days</strong> after the move. Move your
          loot.
        </div>
        <div className={`${s.terms} ${s.mono}`}>
          You will not be able to move again for <strong>7 days</strong>.
        </div>
      </div>

      <button type="button" className={`${s.tap} ${s.primary} ${s.display}`}>
        Confirm the move
      </button>
    </div>
  );
}
