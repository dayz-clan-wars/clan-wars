/**
 * The 390px card from the `Clan Wars Gamertag Link.dc.html` design canvas,
 * on Tailwind. The touch minimums (44 / 52 / 56px) and the step / headline /
 * body / action / footnote structure are the canvas's, unchanged.
 *
 * ⚠️ The refusal block is NOT rust. Rust means an outstanding obligation
 * (frontend rebuild §4); a failed sign-in owes the server nothing. It uses
 * the stronger rule colour and plain ink instead.
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
  actionHref: string;
  footnote: string;
  error?: string;
}) {
  return (
    <div className="w-full max-w-[390px] rounded-lg border border-rule bg-frame p-6">
      <div className="font-mono text-xs uppercase tracking-[0.18em] text-muted">{step}</div>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink">{heading}</h1>
      <p className="mt-3 text-base leading-relaxed text-ink-2">{body}</p>
      {error && (
        <div className="mt-4 rounded-md border border-rule-2 bg-surface p-3" role="alert">
          <div className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Sign-in failed</div>
          <div className="mt-1 text-sm text-ink">{error}</div>
        </div>
      )}
      <a
        className="mt-6 flex min-h-[52px] items-center justify-center rounded-md bg-gold px-4 font-display text-base text-ground"
        href={actionHref}
      >
        {action}
      </a>
      <div className="mt-4 font-mono text-xs leading-relaxed text-muted">{footnote}</div>
    </div>
  );
}
