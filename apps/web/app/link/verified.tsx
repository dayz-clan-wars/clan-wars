import s from "./link.module.css";

/** State 06 — linked. The end of the ladder. */
export function Verified({ gamertag, linkedOn }: { gamertag: string; linkedOn: string }) {
  return (
    <div className={s.card}>
      <div className={`${s.linkedLabel} ${s.mono}`}>Linked</div>
      <h1 className={`${s.headline} ${s.display}`} style={{ marginBottom: 8 }}>
        You&rsquo;re {gamertag}
      </h1>
      <div className={s.badgeRow}>
        <span className={`${s.badge} ${s.mono}`}>Verified</span>
        <span className={`${s.badgeDate} ${s.mono}`}>{linkedOn}</span>
      </div>
      <p className={s.body}>
        Your Discord nickname now matches your gamertag. The map, your roster and
        invitations are open.
      </p>
      <a className={s.cta} href="/mobile">
        <span className={`${s.ctaLabel} ${s.display}`}>Go to the map</span>
        <span className={`${s.ctaArrow} ${s.mono}`} aria-hidden="true">
          &rarr;
        </span>
      </a>
      {/* ⚠️ The block is stated here rather than discovered on tap, and the
          reason is given: a faction whose only leader unlinks is left with
          nobody able to act for it. Same rule the mobile shell's Me screen
          states on its own unlink control. */}
      <div className={`${s.footnote} ${s.mono}`}>
        Unlinking is blocked while you lead a faction — transfer leadership or disband
        first, or the faction is left with nobody able to act for it.
      </div>
    </div>
  );
}
