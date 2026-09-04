import s from "./link.module.css";

/** State 01 — the only door in. Discord OAuth lands on an identity the bot
 *  already trusts, which is why this site needs no account system of its own. */
export function SignedOut({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className={s.card}>
      <div className={`${s.stepLabel} ${s.mono}`}>
        <strong className={s.stepLabelStrong}>Step 1 of 3</strong> — sign in
      </div>
      <h1 className={`${s.headline} ${s.display}`}>Link your character</h1>
      <p className={`${s.body} ${s.bodyWide}`}>
        Sign in with the Discord account you use on the server. Your faction, roster and
        map all hang off this one link.
      </p>
      <button type="button" className={`${s.tap} ${s.primary} ${s.display}`} onClick={onSignIn}>
        Continue with Discord
      </button>
      {/* Says what signing in does NOT buy you. The map and roster genuinely
          need the link, so the sentence is an explanation, not a reassurance. */}
      <div className={`${s.footnote} ${s.mono}`}>
        One character per account. Signing in shows nothing you could not already see —
        the map and roster need the link.
      </div>
    </div>
  );
}
