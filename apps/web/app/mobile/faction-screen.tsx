"use client";

import s from "./mobile.module.css";
import { ROSTER, flagUrl } from "./fixtures";

const FACTS: readonly (readonly [string, string])[] = [
  ["Flag", "Flag_Wolf"],
  ["Founded", "12 Aug 2026"],
  ["Roster", "5 members"],
  ["Base", "Near Topolin"],
];

export function FactionScreen({ onRebind }: { onRebind: () => void }) {
  return (
    <div>
      <div className={s.factionHead}>
        {/* eslint-disable-next-line @next/next/no-img-element -- see map-screen.tsx */}
        <img className={s.factionFlag} src={flagUrl("Flag_Wolf")} alt="" />
        <div className={s.grow}>
          <div className={`${s.factionName} ${s.display}`}>Wolf Tang Clan</div>
          <div className={s.factionTags}>
            <div className={`${s.tagChip} ${s.mono}`}>WTC</div>
            <div className={`${s.statusActive} ${s.mono}`}>● Active</div>
          </div>
        </div>
      </div>

      <div className={s.facts}>
        {FACTS.map(([key, value]) => (
          <div key={key} className={s.fact}>
            <div className={`${s.factKey} ${s.mono}`}>{key}</div>
            <div className={`${s.factValue} ${s.mono}`}>{value}</div>
          </div>
        ))}
      </div>

      {/*
        ⚠️ The promise this paragraph makes is the pole-coordinates invariant
        restated for a surface that has no ephemeral replies: members see the
        marker, nobody sees a number. A future screen that prints a grid
        reference breaks this sentence, not just a preference.
      */}
      <div className={`${s.callout} ${s.mono}`}>
        Your pole is shown on the map to your roster only. Coordinates are never printed —
        nothing here can be copied and pasted to a rival.
      </div>

      <div className={s.rosterSection}>
        <div className={s.rosterHead}>
          <div className={`${s.sectionLabel} ${s.mono}`}>Roster</div>
          <div className={`${s.sectionLabel} ${s.mono}`}>You lead</div>
        </div>

        <div className={s.stack}>
          {ROSTER.map((r) => (
            <div key={r.gamertag} className={s.rosterRow}>
              <div className={s.grow}>
                <div className={`${s.name} ${s.display}`}>{r.gamertag}</div>
                <div className={`${s.meta} ${s.mono}`}>{r.role}</div>
              </div>
              <button
                type="button"
                className={`${s.tap} ${s.manage} ${s.mono}`}
                aria-label={`Manage ${r.gamertag}`}
              >
                …
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className={s.actions}>
        <div className={s.stack}>
          <button type="button" className={`${s.tap} ${s.actionRow} ${s.actionGold}`}>
            <span className={`${s.actionTitleGold} ${s.display}`}>Invite a player</span>
            <span className={`${s.arrowDark} ${s.mono}`}>→</span>
          </button>

          <button type="button" className={`${s.tap} ${s.actionRow}`} onClick={onRebind}>
            <span>
              <span className={`${s.actionTitle} ${s.display}`}>Move the base</span>
              <span className={`${s.actionSub} ${s.mono}`} style={{ display: "block" }}>
                Available now
              </span>
            </span>
            <span className={`${s.arrow} ${s.mono}`}>→</span>
          </button>

          <button type="button" className={`${s.tap} ${s.actionRow}`}>
            <span>
              <span className={`${s.actionTitle} ${s.display}`}>Rename faction</span>
              <span className={`${s.actionSub} ${s.mono}`} style={{ display: "block" }}>
                Once every 7 days
              </span>
            </span>
            <span className={`${s.arrow} ${s.mono}`}>→</span>
          </button>

          <button type="button" className={`${s.tap} ${s.actionRow}`}>
            <span>
              <span className={`${s.actionTitleDanger} ${s.display}`}>Disband</span>
              <span className={`${s.actionSub} ${s.mono}`} style={{ display: "block" }}>
                Releases flag, tag and pole
              </span>
            </span>
            <span className={`${s.arrow} ${s.mono}`}>→</span>
          </button>
        </div>
      </div>
    </div>
  );
}
