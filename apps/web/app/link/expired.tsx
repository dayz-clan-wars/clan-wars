import s from "../auth.module.css";

/** State 05 — the challenge timed out. A branch of pending, not a dead end. */
export function Expired({
  gamertag,
  onDraw,
  onCancel,
}: {
  gamertag: string;
  onDraw: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={`${s.card} ${s.cardOutstanding}`}>
      <div className={`${s.stepLabel} ${s.mono}`}>
        <strong className={s.stepLabelStrong}>Step 3 of 3</strong> — one step left
      </div>
      <h1 className={`${s.headlineSm} ${s.display}`}>
        Your challenge for {gamertag} expired
      </h1>
      {/* ⚠️ "the old sequence no longer links anything" is the load-bearing
          half: a player who performs the lapsed emotes in game gets no
          confirmation and no error, because nothing is listening for them. */}
      <p className={`${s.body} ${s.bodyWide}`}>
        The sequence timed out after 24 hours. Draw a fresh one and perform the new emotes
        in game — the old sequence no longer links anything.
      </p>
      <button type="button" className={`${s.tap} ${s.primary} ${s.display}`} onClick={onDraw}>
        Draw a new sequence
      </button>
      <button type="button" className={`${s.tap} ${s.metaLink} ${s.mono}`} onClick={onCancel}>
        Cancel the claim
      </button>
    </div>
  );
}
