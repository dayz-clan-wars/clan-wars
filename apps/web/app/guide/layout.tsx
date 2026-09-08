import "./guide.css";
import { currentSession } from "@/lib/viewer";
import { SiteBar } from "@/app/(site)/site-bar";
import { buildIndex } from "./index";
import { GuideSearch } from "./search";
import Contents from "./contents";

/**
 * The guide's chrome on the site's own pieces: the top bar (with a "/ Field
 * guide" crumb and, on phones, a Contents button beside Menu), a 300px rail
 * with search and the chapter list, and the reading column.
 *
 * ⚠️ Reads the session for the bar's signed-in state, so the guide renders
 * per request like the rest of the site. It reads no database. The search
 * index is built here from the fragments — at request time, but from files,
 * and it is a few kilobytes.
 */
export const dynamic = "force-dynamic";

export default async function GuideLayout({ children }: { children: React.ReactNode }) {
  const [session, index] = [await currentSession(), buildIndex(true)];
  return (
    <>
      <SiteBar signedIn={session !== null} crumb="Field guide" extra={
        <details className="group relative">
          <summary className="flex min-h-[36px] cursor-pointer list-none items-center border border-rule-2 px-3 font-display text-xs uppercase tracking-[0.06em] text-ink group-open:border-ink [&::-webkit-details-marker]:hidden">Contents</summary>
          <div className="absolute right-0 top-[calc(100%+8px)] z-[1300] max-h-[75vh] w-[min(86vw,320px)] overflow-y-auto border-2 border-rule-2 bg-frame pb-4 pt-3 shadow-[0_16px_40px_rgba(0,0,0,.6)]">
            <div className="px-4 pb-3"><GuideSearch index={index} /></div>
            <Contents />
            <a className="mt-4 block px-6 font-mono text-[11px] uppercase tracking-[0.18em] text-muted" href="/">&larr; Back to the site</a>
          </div>
        </details>
      } />
      <div className="flex min-h-[calc(100dvh-var(--spacing-bar))]">
        <aside className="hidden w-[300px] flex-none border-r-2 border-rule-2 lg:block">
          <div className="sticky top-bar max-h-[calc(100dvh-var(--spacing-bar))] overflow-y-auto pb-10 pt-6">
            <div className="px-6 pb-4"><GuideSearch index={index} /></div>
            <p className="m-0 px-6 pb-4 font-mono text-[10px] uppercase leading-relaxed tracking-[0.18em] text-muted">Field Guide<br />one Xbox server, Livonia</p>
            <Contents />
            <a className="mt-5 block px-6 font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-ink" href="/">&larr; Back to the site</a>
          </div>
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </>
  );
}
