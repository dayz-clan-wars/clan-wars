import s from "../auth.module.css";

/**
 * The sign-in card, from the `Clan Wars Gamertag Link.dc.html` design canvas.
 *
 * ⚠️ Shared by the real `/login` and the `/link` prototype's step 1. The
 * prototype supplies its own fixture copy; the two share the component, not
 * the state — so the demo keeps reading end-to-end while the real screen is
 * the one that actually starts an OAuth round.
 */
export function SignInCard({
  step,
  heading,
  body,
  action,
  actionHref,
  footnote,
  error,
}: {
  step: string;
  heading: string;
  body: string;
  action: string;
  /** Where the button goes. `#` in the prototype, a real endpoint at /login. */
  actionHref: string;
  footnote: string;
  error?: string;
}) {
  return (
    <div className={s.card}>
      <div className={`${s.stepLabel} ${s.mono}`}>{step}</div>
      <h1 className={`${s.headline} ${s.display}`}>{heading}</h1>
      <p className={`${s.body} ${s.bodyWide}`}>{body}</p>
      {error && (
        <div className={s.refusal} role="alert">
          <div className={`${s.refusalLabel} ${s.mono}`}>Sign-in failed</div>
          <div className={s.refusalBody}>{error}</div>
        </div>
      )}
      <a className={`${s.primary} ${s.display}`} href={actionHref}>
        {action}
      </a>
      <div className={`${s.footnote} ${s.mono}`}>{footnote}</div>
    </div>
  );
}
