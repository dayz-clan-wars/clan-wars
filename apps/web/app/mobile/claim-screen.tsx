"use client";

import { useState } from "react";
import s from "./mobile.module.css";
import { HELD, POOL, flagUrl } from "./fixtures";
import { BackLink } from "./back-link";

export function ClaimScreen({ onBack }: { onBack: () => void }) {
  const [picked, setPicked] = useState("Flag_Pirates");

  return (
    <div className={s.screenPad}>
      <BackLink onBack={onBack} />

      {/*
        ⚠️ The ceremony already happened in game; this screen only names what it
        produced. The countdown is the reservation window, and saying it here is
        what stops a player from wandering off mid-claim.
      */}
      <div className={`${s.ceremony} ${s.mono}`}>
        A ceremony was witnessed at a flagpole near <strong>Nadbor</strong> with 3
        participants. You have <strong className={s.clock}>23h 41m</strong> to name the
        faction.
      </div>

      <div className={`${s.sectionLabel} ${s.mono}`} style={{ marginBottom: 10 }}>
        Faction name
      </div>
      <div className={s.field} style={{ marginBottom: 22 }}>
        <div className={`${s.fieldValue} ${s.display}`}>The Nest</div>
      </div>

      <div className={`${s.sectionLabel} ${s.mono}`} style={{ marginBottom: 10 }}>
        Tag — 2 to 5 letters or digits
      </div>
      <div className={s.tagRow}>
        <div className={`${s.field} ${s.tagField}`}>
          <div className={`${s.tagValue} ${s.mono}`}>NEST</div>
        </div>
        <div className={`${s.available} ${s.mono}`}>Available</div>
      </div>

      <div className={`${s.sectionLabel} ${s.mono}`} style={{ marginBottom: 12 }}>
        Claim a flag — 21 left in the pool
      </div>
      <div className={s.flagGrid}>
        {POOL.map((texture) => {
          const taken = HELD.includes(texture);
          return (
            <button
              key={texture}
              type="button"
              className={`${s.tap} ${s.flagCell}`}
              // ⚠️ Disabled, not merely overlaid. The "Held" scrim is a visual
              // cue; this is what stops a tap landing on a flag that cannot be
              // claimed and silently doing nothing.
              disabled={taken}
              aria-pressed={picked === texture}
              aria-label={taken ? `${texture} — held` : texture}
              onClick={() => setPicked(texture)}
            >
              <span
                className={s.flagCellImage}
                style={{ backgroundImage: `url(${flagUrl(texture)})` }}
              />
              {picked === texture && !taken && <span className={s.flagPicked} />}
              {taken && (
                <span className={s.flagTaken}>
                  <span className={`${s.flagTakenChip} ${s.mono}`}>Held</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      <button type="button" className={`${s.tap} ${s.primary} ${s.display}`} style={{ marginBottom: 16 }}>
        Reserve the claim
      </button>

      {/* ⚠️ "Lower any flag already flying first" is the load-bearing half:
          only the act of RAISING is recorded, so a player who raises over a
          flag that is already up produces no event and no faction. */}
      <div className={`${s.footnote} ${s.mono}`}>
        Reserving holds the flag, tag and pole for 24 hours. To bring the faction to life,
        raise your flag at the pole — lower any flag already flying first, because only
        the act of raising is recorded.
      </div>
    </div>
  );
}
