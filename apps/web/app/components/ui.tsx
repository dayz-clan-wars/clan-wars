/**
 * The site's building blocks, from the "Dispatch" direction of the
 * `Clan Wars Redesign.dc.html` design canvas (2026-09-07): squared 2px
 * frames, numbered panel heads, uppercase display headings, a mono kicker.
 * Every page composes these; none restates a colour or a face — the tokens
 * live in globals.css.
 */

/** The mono caption: 11px, uppercase, tracked. */
export const kicker = "font-mono text-[11px] uppercase tracking-[0.18em] text-muted";
/** A sub-caption inside a panel: same voice, one step smaller. */
export const kickerSm = "font-mono text-[10px] uppercase tracking-[0.18em] text-muted";

/** Buttons. All meet the 44px touch minimum; primary and CTA are taller. */
export const btnPrimary = "inline-flex min-h-[44px] items-center justify-center gap-3 bg-gold px-4 font-display text-xs uppercase tracking-[0.06em] text-ground hover:bg-gold-hover disabled:opacity-40";
export const btnCta = "flex min-h-[56px] items-center justify-between gap-6 bg-gold px-5 font-display text-[15px] uppercase tracking-[0.04em] text-ground hover:bg-gold-hover disabled:opacity-40";
export const btnSecondary = "inline-flex min-h-[44px] items-center justify-center gap-3 border-2 border-rule-2 px-4 font-display text-xs uppercase tracking-[0.06em] text-ink hover:border-muted disabled:opacity-40";
export const btnDanger = "inline-flex min-h-[44px] items-center justify-center gap-3 border-2 border-rust px-4 font-display text-xs uppercase tracking-[0.06em] text-ink hover:bg-rust/15 disabled:opacity-40";
export const btnQuiet = "inline-flex min-h-[44px] items-center font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-ink disabled:opacity-40";
/** A text link inside prose. */
export const link = "text-gold underline-offset-4 hover:underline";
/** A mono, tracked, inline link (the "Full board →" kind). */
export const linkMono = "font-mono text-[11px] uppercase tracking-[0.18em] text-gold hover:underline underline-offset-4";

/** Form fields: 52px, squared, ground-black on the frame. */
export const field = "mt-1 block min-h-[52px] w-full border-2 border-rule-2 bg-ground px-4 font-mono text-sm text-ink placeholder:text-dim focus:border-gold focus:outline-none";
export const checkbox = "h-5 w-5 flex-none border-2 border-rule-2 bg-ground accent-gold";

/** The page column. Wide pages use `wide`; reading pages the default. */
export function Page({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return <main className={`mx-auto w-full ${wide ? "max-w-[1280px]" : "max-w-[64rem]"}`}>{children}</main>;
}

/**
 * The page head: kicker, uppercase display title, an optional line under it
 * and an optional right-hand slot (a segmented nav, a CTA, a status). Closes
 * with the 2px rule every page in the canvas has.
 */
export function PageHead({ kicker: k, title, sub, aside, icon, guide }: {
  kicker: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; aside?: React.ReactNode; icon?: React.ReactNode;
  /** The chapter this page is explained by (lib/guide-links.ts): "In the guide: 4. Bases →". */
  guide?: { href: string; label: string };
}) {
  return (
    <div className="flex flex-col gap-5 border-b-2 border-rule-2 px-5 pb-5 pt-6 lg:flex-row lg:items-end lg:justify-between lg:gap-8 lg:px-8 lg:pb-6 lg:pt-10">
      <div className="flex items-center gap-4 lg:gap-6">
        {icon}
        <div className="min-w-0">
          <div className={kicker}>{k}</div>
          <h1 className="mt-2 font-display text-[clamp(2.25rem,6vw,4rem)] uppercase leading-[.9] tracking-[-0.02em] text-ink [overflow-wrap:anywhere]">{title}</h1>
          {sub && <div className="mt-2 text-sm text-ink-2">{sub}</div>}
          {guide && <GuideLine guide={guide} className="mt-3 lg:hidden" />}
        </div>
      </div>
      {(aside || guide) && (
        <div className="flex flex-none flex-col items-start gap-3 lg:items-end">
          {guide && <GuideLine guide={guide} className="hidden lg:flex" />}
          {aside}
        </div>
      )}
    </div>
  );
}

/** "In the guide: 4. Bases →", the mono voice, gold on hover. */
export function GuideLine({ guide, className = "" }: { guide: { href: string; label: string }; className?: string }) {
  return (
    <a href={guide.href} className={`items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-gold ${className.includes("hidden") ? className : `flex ${className}`}`}>
      <span className="text-dim">In the guide:</span> {guide.label} <span aria-hidden="true">→</span>
    </a>
  );
}

/** The content band under a PageHead. */
export function Body({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`px-5 py-5 lg:px-8 lg:pb-10 lg:pt-6 ${className}`}>{children}</div>;
}

/**
 * A framed panel with a numbered head. `tone="gold"` is the one loud device
 * on a page (a ceremony waiting, recruiting); `tone="rust"` marks an open
 * obligation (a link challenge) — never a generic error.
 */
export function Panel({ num, title, aside, tone = "plain", children, className = "" }: {
  num?: string; title?: React.ReactNode; aside?: React.ReactNode; tone?: "plain" | "gold" | "rust"; children: React.ReactNode; className?: string;
}) {
  const edge = tone === "gold" ? "border-gold" : tone === "rust" ? "border-rust" : "border-rule-2";
  const head = tone === "gold" ? "text-gold" : "text-ink";
  return (
    <section className={`border-2 ${edge} bg-frame ${className}`}>
      {title && (
        <div className={`flex items-center justify-between gap-4 border-b-2 ${edge} px-4 py-3 lg:px-5`}>
          <h2 className={`m-0 font-display text-[13px] uppercase tracking-[0.06em] lg:text-sm ${head}`}>
            {num && <span className={`mr-3 ${tone === "rust" ? "text-rust" : "text-gold"}`}>{num}</span>}{title}
          </h2>
          {aside && <div className="font-mono text-[11px] text-muted">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A panel's padded body. */
export function PanelBody({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`p-4 lg:p-5 ${className}`}>{children}</div>;
}

/** A status line — the result of a form post, looked up from copy. */
export function Notice({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "gold" | "rust" }) {
  const edge = tone === "gold" ? "border-gold" : tone === "rust" ? "border-rust" : "border-rule-2";
  return <p role="status" className={`border ${edge} bg-surface px-4 py-3 text-sm text-ink`}>{children}</p>;
}

/** The bordered segmented nav: scoreboard/alphas/seasons, all-time/season N. */
export function SegNav({ items, label, className = "" }: { items: { label: string; href: string; current?: boolean }[]; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={`flex border-2 border-rule-2 font-display text-xs uppercase tracking-[0.04em] ${className}`}>
      {items.map((it, i) => (
        <a key={it.href} href={it.href} aria-current={it.current ? "page" : undefined}
          className={`flex min-h-[44px] flex-1 items-center justify-center whitespace-nowrap px-3 text-center lg:flex-none lg:px-[18px] ${i > 0 ? "border-l border-rule-2" : ""} ${it.current ? "bg-gold text-ground" : "text-ink hover:bg-surface"}`}>
          {it.label}
        </a>
      ))}
    </nav>
  );
}

/** A big number with a caption, for stat strips. */
export function Stat({ value, label, tone = "ink" }: { value: React.ReactNode; label: React.ReactNode; tone?: "ink" | "gold" }) {
  return (
    <div className="px-5 py-4 lg:px-8 lg:py-5">
      <div className={`font-display text-[30px] leading-none lg:text-[40px] ${tone === "gold" ? "text-gold" : "text-ink"}`}>{value}</div>
      <div className={`mt-1.5 ${kickerSm}`}>{label}</div>
    </div>
  );
}

/** A rank numeral: gold for the podium, dim below it, an em dash for unranked. */
export function Rank({ n, size = "md" }: { n: number | null; size?: "md" | "lg" }) {
  const podium = n !== null && n <= 3;
  return <span className={`font-display leading-none ${size === "lg" ? "text-[22px] lg:text-[28px]" : "text-lg"} ${podium ? "text-gold" : "text-dim"}`}>{n ?? "—"}</span>;
}

/** The line every page ends on. */
export const HONEST = "Nothing on this page is invented: it is what the server log has recorded.";
export function Footer({ children }: { children?: React.ReactNode }) {
  return (
    <footer className="flex flex-col gap-3 border-t-2 border-rule-2 bg-frame px-5 py-4 font-mono text-[11px] leading-relaxed text-dim lg:flex-row lg:items-center lg:justify-between lg:px-8">
      <span>{HONEST}</span>
      {children && <span className="flex gap-6 uppercase tracking-[0.18em]">{children}</span>}
    </footer>
  );
}

/** A dl of label/value pairs in the canvas's two-column voice. */
export function Facts({ items, className = "" }: { items: [React.ReactNode, React.ReactNode][]; className?: string }) {
  return (
    <dl className={`grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm leading-relaxed text-ink-2 ${className}`}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className={`${kickerSm} pt-[3px]`}>{k}</dt>
          <dd className="m-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
