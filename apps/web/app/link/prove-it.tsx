"use client";

import s from "../auth.module.css";
import { SEQUENCE } from "./fixtures";
import { Refusal } from "./refusal";

/**
 * State 03/04 — the challenge, at any confirmed count.
 *
 * ⚠️ There is no polling here and no timer that advances `confirmed` on its
 * own. In the built version this card polls the pending link on a short
 * interval so a confirmation appears without a reload; faking that in a
 * fixtures route would mean inventing server confirmations, which is the one
 * thing this whole flow exists to say only the server can do.
 */
export function ProveIt({
  gamertag,
  confirmed,
  expiresIn,
  drawsLeft,
  replaced,
  onDraw,
  onCancel,
}: {
  gamertag: string;
  /** How many of the three the SERVER has confirmed. Never a guess. */
  confirmed: number;
  expiresIn: string;
  drawsLeft: number;
  /** The character whose challenge this one replaced, if any. */
  replaced?: string | null;
  onDraw: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={`${s.card} ${s.cardOutstanding}`}>
      <div className={`${s.stepLabel} ${s.mono}`}>
        <strong className={s.stepLabelStrong}>Step 3 of 3</strong> — one step left
      </div>
      <h1 className={`${s.headlineLg} ${s.display}`}>
        Prove it&rsquo;s
        <br />
        you
      </h1>
      <div className={`${s.gamertag} ${s.mono}`}>{gamertag}</div>

      {replaced && (
        <Refusal label="Switched character" neutral>
          Canceled your challenge for {replaced} — that sequence no longer works. Here is
          the new one.
        </Refusal>
      )}

      <p className={s.body}>
        In game as that character, open the emote wheel and perform these three, in this
        order. Other emotes in between are fine — the order is what counts.
      </p>

      {/* ⚠️ An ordered list, because the order IS the proof. Styled divs would
          leave a screen-reader user with three emotes and no sequence. */}
      <ol className={s.sequence}>
        {SEQUENCE.map((step, i) => {
          const done = i < confirmed;
          return (
            <li key={step.emote} className={`${s.step} ${done ? s.stepConfirmed : ""}`}>
              <span
                className={`${s.stepOrdinal} ${done ? s.stepOrdinalConfirmed : ""} ${s.mono}`}
              >
                {step.ordinal}
              </span>
              <span className={`${s.stepName} ${done ? s.stepNameConfirmed : ""} ${s.display}`}>
                {step.emote}
              </span>
              {/* Only a confirmed step renders differently. There is deliberately
                  no marker for "the one you should do next" — the page cannot
                  know that, and a pointer that guesses reads as broken. */}
              {done && (
                <span className={s.stamp} aria-hidden="true">
                  <span className={`${s.stampInk} ${s.display}`}>Confirmed</span>
                </span>
              )}
              {done && <span className={s.srOnly}>Confirmed</span>}
            </li>
          );
        })}
      </ol>

      {/*
        ⚠️ A SIBLING of the list, never an attribute on it. Putting
        aria-live on the <ol> strips its list semantics in several screen
        readers, which costs exactly the ordering the challenge is made of.
      */}
      <p role="status" aria-live="polite" className={s.srOnly}>
        {confirmed} of {SEQUENCE.length} confirmed
      </p>

      <div className={s.note}>
        <strong className={s.noteStrong}>
          The server has confirmed {confirmed} of {SEQUENCE.length}.
        </strong>{" "}
        DayZ reports emotes in batches, so confirmations land minutes behind and this page
        does not update in real time. Perform all three and you can log off — the link
        catches up on its own.
      </div>

      <div className={s.metaRow}>
        <div className={`${s.expiry} ${s.mono}`}>Expires in {expiresIn}</div>
        <div className={s.metaLinks}>
          <button
            type="button"
            className={`${s.tap} ${s.metaLink} ${s.mono}`}
            onClick={onDraw}
            disabled={drawsLeft === 0}
          >
            New sequence
          </button>
          <button type="button" className={`${s.tap} ${s.metaLink} ${s.mono}`} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>

      {drawsLeft > 0 ? (
        <div className={`${s.drawNote} ${s.mono}`}>
          Can&rsquo;t find one of these on the wheel? Draw a new sequence — {drawsLeft}{" "}
          {drawsLeft === 1 ? "draw" : "draws"} left today.
        </div>
      ) : (
        <div style={{ marginTop: 14 }}>
          <Refusal label="Out of draws">
            You&rsquo;ve asked for too many sequences for this character today. Try again
            tomorrow — or, if there&rsquo;s an emote you can&rsquo;t find on the wheel, say
            so in the channel rather than working around it.
          </Refusal>
        </div>
      )}
    </div>
  );
}
