import { btnCta } from "./ui";

/**
 * The sign-in screen from the design canvas: on desktop a two-column spread
 * — a step badge, a display headline and the body on the left, the action
 * card on the right; on phones the same things stacked. The touch minimums
 * (44 / 52 / 56px) and the step / headline / body / action / footnote
 * structure are the canvas's, unchanged.
 *
 * ⚠️ The refusal block is NOT rust. Rust means an outstanding obligation
 * (frontend rebuild §4); a failed sign-in owes the server nothing. It uses
 * the stronger rule colour and plain ink instead.
 */
export function SignInCard({ step, heading, body, action, actionHref, footnote, error, cardLabel = "Sign in" }: {
  step: string; heading: string; body: string; action: string; actionHref: string; footnote: string; error?: string; cardLabel?: string;
}) {
  return (
    <div className="grid w-full gap-8 px-5 py-7 lg:min-h-[calc(100dvh-var(--spacing-bar))] lg:grid-cols-2 lg:items-center lg:gap-16 lg:px-8 lg:py-0">
      <div>
        <div className="inline-flex items-center gap-3 border border-gold px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-gold lg:text-[11px]">{step}</div>
        <h1 className="mt-4 font-display text-[40px] uppercase leading-[.9] tracking-[-0.02em] text-ink lg:mt-5 lg:text-[72px]">{heading}</h1>
        <p className="mt-4 max-w-[480px] text-base leading-relaxed text-ink-2 [text-wrap:pretty] lg:mt-6 lg:text-lg">{body}</p>
        <div className="mt-6 lg:hidden">
          <a className={btnCta} href={actionHref}>{action} <span className="font-mono normal-case">→</span></a>
          {error && <Refusal>{error}</Refusal>}
          <div className="mt-4 font-mono text-[11px] leading-relaxed text-muted">{footnote}</div>
        </div>
      </div>
      <div className="hidden w-full max-w-[440px] border-2 border-rule-2 bg-frame p-7 lg:block lg:justify-self-end">
        <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">{cardLabel}</div>
        <a className={`mt-5 ${btnCta}`} href={actionHref}>{action} <span className="font-mono normal-case">→</span></a>
        {error && <Refusal>{error}</Refusal>}
        <div className="mt-5 font-mono text-[11px] leading-relaxed text-muted">{footnote}</div>
      </div>
    </div>
  );
}

function Refusal({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 border border-rule-2 bg-surface px-3.5 py-3" role="alert">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">Sign-in failed</div>
      <div className="mt-1 text-sm leading-relaxed text-ink">{children}</div>
    </div>
  );
}
