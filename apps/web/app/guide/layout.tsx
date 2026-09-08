import "./guide.css";
import { currentSession } from "@/lib/viewer";
import { SiteBar } from "@/app/(site)/site-bar";
import Contents from "./contents";

/**
 * The guide's chrome, from the design canvas: the site's own top bar (with
 * a "/ Field guide" crumb and, on phones, a Contents button beside Menu),
 * a 300px chapter rail on desktop, and the reading column. The chapter
 * pages fill the column.
 *
 * ⚠️ Reads the session for the bar's signed-in state, so the guide renders
 * per request like the rest of the site. It reads no database; the cost is
 * a cookie decode. Chapter pages still declare their static params so an
 * unknown slug is a 404.
 */
export const dynamic = "force-dynamic";

export default async function GuideLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  return (
    <div className="guide">
      <SiteBar signedIn={session !== null} crumb="Field guide" extra={
        <details className="group relative">
          <summary className="flex min-h-[36px] cursor-pointer list-none items-center border border-rule-2 px-3 font-display text-xs uppercase tracking-[0.06em] text-ink group-open:border-ink [&::-webkit-details-marker]:hidden">Contents</summary>
          <div className="menu"><Contents /><a className="site-link" href="/">&larr; Back to the site</a></div>
        </details>
      } />
      <div className="shell">
        <aside className="rail">
          <div className="rail-inner">
            <p className="kicker">Field Guide<br />one Xbox server, Livonia</p>
            <Contents />
          </div>
        </aside>
        <main>{children}</main>
      </div>
    </div>
  );
}
