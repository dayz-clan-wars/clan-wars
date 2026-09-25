import { Page } from "@/app/components/ui";

/** The 404, in the site's own voice — Next's default is an unstyled white-on-black card. */
export default function NotFound() {
  return (
    <Page>
      <div className="px-5 pb-10 pt-16 lg:px-8 lg:pt-24">
        <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">404</div>
        <h1 className="mt-2 font-display text-[clamp(2.25rem,6vw,4rem)] uppercase leading-[.9] tracking-[-0.02em] text-ink">Nothing here.</h1>
        <p className="mt-4 max-w-[36rem] text-sm leading-relaxed text-ink-2">That address is not a page on this site. The log did not put it there, and neither did we.</p>
        {/* Outside (site), so there is no bar here: these two links are the only way on, and each is a full 44px target (L5). */}
        <p className="mt-6 flex flex-wrap gap-x-6 font-mono text-[11px] uppercase tracking-[0.18em]">
          <a className="inline-flex min-h-[44px] items-center text-gold underline-offset-4 hover:underline" href="/">The front page</a>
          <a className="inline-flex min-h-[44px] items-center text-gold underline-offset-4 hover:underline" href="/guide">The field guide</a>
        </p>
      </div>
    </Page>
  );
}
