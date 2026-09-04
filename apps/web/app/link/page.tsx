"use client";

import { useEffect, useState } from "react";
import s from "../auth.module.css";
import { archivo, archivoBlack, spaceMono } from "../fonts";
import {
  DRAWS_USED,
  EXPIRY_AT_TWO,
  EXPIRY_AT_ZERO,
  LINKED_ON,
  MAX_DRAWS_PER_DAY,
  SEQUENCE,
  SUBJECT,
} from "./fixtures";
import type { LinkState } from "./types";
import { SignedOut } from "./signed-out";
import { ChooseCharacter } from "./choose-character";
import { ProveIt } from "./prove-it";
import { Expired } from "./expired";
import { Verified } from "./verified";

/**
 * The character-link flow for dayzclanwars.com, ported from the
 * `Clan Wars Gamertag Link.dc.html` design canvas.
 *
 * ⚠️ Fixtures end to end. This route reads no database, calls no API, and has
 * no session — "Continue with Discord" authenticates nothing and "Claim it"
 * links nothing. The site is a surface, never a source of truth, and
 * `apps/web/test/smoke.test.ts` is what holds that line now that the live
 * database sits one loopback port away.
 *
 * ⚠️ It is therefore noindex AND unlinked from the landing page, and it says so
 * on the page itself. A flow that imitates a sign-in is the one kind of
 * prototype a player could be harmed by mistaking for the real thing — not
 * because it takes anything from them, but because they would perform three
 * emotes in game and wait for a link that is never coming.
 */
export default function LinkPage() {
  /** ⚠️ Starts at `loading` and renders nothing until resolved — see types.ts. */
  const [state, setState] = useState<LinkState>("loading");
  const [subject, setSubject] = useState(SUBJECT);
  const [confirmed, setConfirmed] = useState(0);
  const [drawsUsed, setDrawsUsed] = useState(DRAWS_USED);
  const [replaced, setReplaced] = useState<string | null>(null);

  // Stands in for resolving the session. In the built version this is where the
  // Discord identity lands; here it only proves `loading` renders nothing.
  useEffect(() => setState("signedOut"), []);

  const drawsLeft = Math.max(0, MAX_DRAWS_PER_DAY - drawsUsed);

  const claim = (gamertag: string) => {
    // A new claim replaces any outstanding challenge — and says so, because the
    // old sequence silently stops working the moment this one is drawn.
    setReplaced(state === "pending" && subject !== gamertag ? subject : null);
    setSubject(gamertag);
    setConfirmed(0);
    setState("pending");
  };

  const draw = () => {
    setDrawsUsed((n) => n + 1);
    setConfirmed(0);
    setReplaced(null);
    setState("pending");
  };

  const cancel = () => {
    setReplaced(null);
    setConfirmed(0);
    setState("unlinked");
  };

  /** The prototype's state control. Not part of the design — see the banner. */
  const jump = (next: LinkState, count = 0) => {
    setConfirmed(count);
    setReplaced(null);
    setState(next);
  };

  return (
    <div className={`${s.page} ${archivo.variable} ${archivoBlack.variable} ${spaceMono.variable}`}>
      <div className={s.banner}>
        <strong className={`${s.bannerLabel} ${s.mono}`}>Prototype — links nothing</strong>
        Every character, sequence and confirmation on this page is invented. Signing in
        authenticates nothing and no challenge is ever issued to the game server.
      </div>

      <div className={s.switcher}>
        <div className={`${s.switcherLabel} ${s.mono}`}>Jump to a state</div>
        <div className={s.switcherRow}>
          {(
            [
              ["Signed out", "signedOut" as LinkState, 0],
              ["Unlinked", "unlinked" as LinkState, 0],
              ["Pending 0/3", "pending" as LinkState, 0],
              ["Pending 2/3", "pending" as LinkState, 2],
              ["Expired", "expired" as LinkState, 0],
              ["Verified", "verified" as LinkState, 0],
            ] as const
          ).map(([label, next, count]) => (
            <button
              key={label}
              type="button"
              className={`${s.tap} ${s.switcherItem} ${s.mono} ${
                state === next && (next !== "pending" || confirmed === count)
                  ? s.switcherItemOn
                  : ""
              }`}
              onClick={() => jump(next, count)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ⚠️ `loading` renders nothing at all, deliberately. Anything here — a
          spinner, a skeleton, a stale card — is a claim about a state that has
          not resolved yet. */}
      {state === "signedOut" && <SignedOut onSignIn={() => setState("unlinked")} />}
      {state === "unlinked" && <ChooseCharacter onClaim={claim} />}
      {state === "pending" && confirmed < SEQUENCE.length && (
        <ProveIt
          gamertag={subject}
          confirmed={confirmed}
          expiresIn={confirmed === 0 ? EXPIRY_AT_ZERO : EXPIRY_AT_TWO}
          drawsLeft={drawsLeft}
          replaced={replaced}
          onDraw={draw}
          onCancel={cancel}
        />
      )}
      {/* All three confirmed IS verified — one derivation, so the two surfaces
          cannot disagree about whether the link landed. */}
      {((state === "pending" && confirmed >= SEQUENCE.length) || state === "verified") && (
        <Verified gamertag={subject} linkedOn={LINKED_ON} />
      )}
      {state === "expired" && <Expired gamertag={subject} onDraw={draw} onCancel={cancel} />}
    </div>
  );
}
