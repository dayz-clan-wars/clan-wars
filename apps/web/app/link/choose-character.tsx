"use client";

import { useState } from "react";
import s from "../auth.module.css";
import { CHARACTERS } from "./fixtures";
import { Refusal } from "./refusal";
import type { Character } from "./types";

/** Why the last submit was refused. Null once the player edits the field. */
type Denial = { kind: "unseen" } | { kind: "blocked"; character: Character } | null;

/** State 02 — name the character. */
export function ChooseCharacter({ onClaim }: { onClaim: (gamertag: string) => void }) {
  const [query, setQuery] = useState("");
  const [denial, setDenial] = useState<Denial>(null);

  const matches = CHARACTERS.filter((c) =>
    c.gamertag.toLowerCase().startsWith(query.trim().toLowerCase()),
  );

  /**
   * ⚠️ Resolved from the typed text on submit, NOT from whatever row was last
   * clicked. The design is explicit that autocomplete is a suggestion and the
   * choice is re-validated here — a player can type a full gamertag and never
   * touch the list, and trusting a stale selection would claim the wrong
   * character for them.
   */
  const claim = () => {
    const typed = query.trim();
    const found = CHARACTERS.find((c) => c.gamertag.toLowerCase() === typed.toLowerCase());
    if (!found) return setDenial({ kind: "unseen" });
    if (found.blocked) return setDenial({ kind: "blocked", character: found });
    onClaim(found.gamertag);
  };

  const edit = (next: string) => {
    setQuery(next);
    setDenial(null);
  };

  return (
    <div className={s.card}>
      <div className={`${s.stepLabel} ${s.mono}`}>
        <strong className={s.stepLabelStrong}>Step 2 of 3</strong> — name your character
      </div>
      <h1 className={`${s.headline} ${s.display}`}>Which one is you?</h1>
      <p className={s.body}>
        The gamertag you play under. We only list characters the server has actually seen.
      </p>

      <div className={s.field}>
        <input
          className={`${s.fieldInput} ${s.mono}`}
          value={query}
          onChange={(e) => edit(e.target.value)}
          placeholder="Gamertag"
          aria-label="Gamertag"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className={s.options}>
        {matches.length === 0 && (
          <div className={`${s.optionsEmpty} ${s.mono}`}>No character by that name</div>
        )}
        {matches.map((c) => {
          const chosen = c.gamertag.toLowerCase() === query.trim().toLowerCase();
          const blocked = Boolean(c.blocked);
          return (
            <button
              key={c.gamertag}
              type="button"
              // ⚠️ Disabled, not merely faded. A blocked row that still accepts
              // a tap puts the name in the field and then refuses it on submit,
              // which reads as the site changing its mind.
              disabled={blocked}
              className={`${s.tap} ${s.option} ${chosen && !blocked ? s.optionOn : ""} ${
                blocked ? s.optionBlocked : ""
              }`}
              onClick={() => edit(c.gamertag)}
            >
              <span
                className={`${s.optionName} ${chosen && !blocked ? s.optionNameOn : ""} ${s.mono}`}
              >
                {c.gamertag}
              </span>
              <span
                className={`${s.optionMeta} ${s.mono} ${
                  blocked ? s.optionMetaBlocked : chosen ? s.optionMetaOn : ""
                }`}
              >
                {c.blocked === "linked"
                  ? "Already linked"
                  : c.blocked === "verifying"
                    ? "Being verified"
                    : c.seen}
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className={`${s.tap} ${s.primary} ${s.display}`}
        onClick={claim}
        disabled={query.trim().length === 0}
      >
        Claim it
      </button>

      {denial?.kind === "unseen" && (
        <Refusal label="Never seen">
          We haven&rsquo;t seen that character on the server. Pick one from the list — only
          characters the event log has seen can be linked.
        </Refusal>
      )}

      {denial?.kind === "blocked" && denial.character.blocked === "linked" && (
        <Refusal label="Already linked">
          {denial.character.gamertag} is already linked to another account. If that
          character is yours, ask an admin.
        </Refusal>
      )}

      {denial?.kind === "blocked" && denial.character.blocked === "verifying" && (
        <Refusal label="Someone else is verifying it">
          Another account is verifying {denial.character.gamertag} right now, so we
          can&rsquo;t issue a challenge for it yet. Their attempt ends in{" "}
          {denial.character.contestedFor}.
        </Refusal>
      )}

      <div className={`${s.footnote} ${s.mono}`}>
        Picking the wrong one costs a re-pick, not a lockout — naming a different character
        replaces the challenge.
      </div>
    </div>
  );
}
