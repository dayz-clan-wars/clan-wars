import { GuideLine, kicker } from "./ui";

/**
 * The head of a clan page, public or your own — "Clan Hero.dc.html"
 * (2026-09-09). The clan's flag is the whole ground: blown up and blurred
 * behind everything, and hung once more at the right on a pole, framed like
 * the map's base marker. The copy sits at the foot on desktop and under a
 * 200px flag strip on a phone.
 *
 * `facts` are the mono line under the name — "#1 · 48 pts", "6 members" —
 * each with its value lit (`Lit`). `aside` is the right-hand column: the
 * request-to-join button on the public page, the clan's own page tabs on
 * yours. It renders at the right of the hero on desktop, hugging its own
 * width, and under the copy on a phone.
 *
 * ⚠️ The flag src is one of the 33 committed textures (src/flag-images.ts),
 * never a user-supplied URL — which is the only reason it goes into a
 * `background-image` style.
 */
export function ClanHero({ flagSrc, kicker: k, title, facts, aside, guide, compact = false }: {
  flagSrc: string;
  /** A smaller title, for names that are one long word (gamertags), so they do not break mid-word. */
  compact?: boolean;
  kicker: React.ReactNode;
  title: string;
  facts: React.ReactNode[];
  aside?: React.ReactNode;
  guide?: { href: string; label: string };
}) {
  return (
    <section className="relative border-b-2 border-rule-2 lg:flex lg:h-[360px] lg:flex-col lg:justify-end">
      {/* The ground: on a phone a 200px strip over the copy; on desktop the whole section. */}
      <div aria-hidden="true" className="relative flex h-[200px] items-center justify-center overflow-hidden border-b-2 border-rule-2 lg:absolute lg:inset-0 lg:h-auto lg:border-b-0">
        <div className="absolute -inset-10 scale-110 bg-cover bg-center opacity-55 blur-[24px] saturate-[1.2] lg:blur-[28px]" style={{ backgroundImage: `url(${flagSrc})` }} />
        <div className="clan-hero-fade absolute inset-0" />
        <div className="hero-grid absolute inset-0" />
        {/* The flag on a phone: centred in the strip. */}
        <span className="relative border-[3px] border-frame bg-frame leading-none shadow-[0_16px_32px_rgba(5,5,5,.6)] lg:hidden">
          <img src={flagSrc} alt="" width={256} height={128} className="block" />
        </span>
        {/* The flag on desktop: hung on a pole at the right, framed like a base marker. */}
        <div className="absolute right-8 top-10 hidden items-start lg:flex">
          <span className="h-[296px] w-1.5 bg-frame shadow-[0_0_0_1px_rgba(255,255,255,.06)]" />
          <span className="border-4 border-frame bg-frame leading-none shadow-[0_24px_48px_rgba(5,5,5,.6)]">
            <img src={flagSrc} alt="" width={416} height={208} className="block" />
          </span>
        </div>
      </div>

      <div className="relative flex flex-col gap-3 px-5 pb-5 pt-5 lg:flex-row lg:items-end lg:justify-between lg:gap-8 lg:px-8 lg:pb-7 lg:pt-0">
        {/* ⚠️ Capped on desktop so the copy never runs under the flag on its pole (416px flag + pole + the right inset). */}
        <div className="min-w-0 lg:max-w-[calc(100%-480px)]">
          {guide && <GuideLine guide={guide} className="mb-3 lg:mb-4" />}
          <div className={`${kicker} leading-relaxed`}>{k}</div>
          <h1 className={`mt-2 font-display uppercase leading-[.9] tracking-[-0.02em] text-ink [overflow-wrap:anywhere] lg:mt-3 lg:leading-[.86] lg:[text-shadow:0_2px_24px_rgba(5,5,5,.9)] ${compact ? "text-[36px] lg:text-[clamp(36px,3.6vw,64px)]" : "text-[48px] lg:text-[clamp(56px,7.5vw,96px)]"}`}>{title}</h1>
          {facts.length > 0 && (
            <div className={`${kicker} mt-3 flex flex-wrap gap-x-5 gap-y-2 lg:mt-5 lg:gap-x-7`}>
              {facts.map((f, i) => <span key={i}>{f}</span>)}
            </div>
          )}
        </div>
        {aside && <div className="mt-2 flex flex-none flex-col gap-2.5 lg:mt-0 lg:items-end">{aside}</div>}
      </div>
    </section>
  );
}

/** A fact's lit value, for the mono line under the name. */
export function Lit({ children }: { children: React.ReactNode }) {
  return <span className="text-ink">{children}</span>;
}
