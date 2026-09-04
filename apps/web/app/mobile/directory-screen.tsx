"use client";

import s from "./mobile.module.css";
import { DIRECTORY, flagUrl } from "./fixtures";

export function DirectoryScreen() {
  return (
    <div className={s.screenPad}>
      {/*
        Roster membership is public on purpose — knowing who flies which flag is
        the point of flying one. That is deliberately NOT the same rule as pole
        coordinates: who someone is is public, where their base is is not.
      */}
      <div className={`${s.directoryNote} ${s.mono}`}>
        Who flies which flag is public. 12 of 33 flags are held.
      </div>

      <div className={s.stack}>
        {DIRECTORY.map((d) => (
          <button key={d.tag} type="button" className={`${s.tap} ${s.directoryRow}`}>
            <span
              className={`${s.flagTile} ${s.directoryFlag}`}
              style={{ backgroundImage: `url(${flagUrl(d.flag)})` }}
            />
            <span className={s.grow}>
              <span className={`${s.directoryName} ${s.display}`} style={{ display: "block" }}>
                {d.name}
              </span>
              <span className={`${s.meta} ${s.mono}`} style={{ display: "block" }}>
                {d.meta}
              </span>
            </span>
            <span className={`${s.directoryTag} ${s.mono}`}>{d.tag}</span>
          </button>
        ))}
      </div>

      <div className={s.panel}>
        <div className={`${s.panelLabel} ${s.mono}`}>Rankings</div>
        <div className={`${s.panelHeading} ${s.display}`}>Not scored yet</div>
        <div className={s.panelBody}>
          Raid-weekend scoring and per-faction player boards land here once the season
          structure is live.
        </div>
      </div>
    </div>
  );
}
