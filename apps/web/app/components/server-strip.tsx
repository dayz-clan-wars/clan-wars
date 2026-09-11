import { marqueeSeconds, splitLine, type ServerStripLine } from "@/lib/server-strip";

/**
 * The server-name marquee directly under the top bar, in the bar's own
 * frame: "SERVER NAME: <name>" in display caps, gold on the name, scrolling
 * right to left and looping. The line is rendered twice inside one track so
 * the loop is seamless (the track slides by half its width, which is one
 * copy); `aria-hidden` on the second keeps a screen reader from hearing it
 * twice. Under prefers-reduced-motion the track sits still (globals.css).
 *
 * A server component: nothing to click, nothing to hydrate. Nothing to
 * show renders nothing — a fresh install with no swept server has no strip,
 * not an empty one.
 */
export function ServerStrip({ lines }: { lines: ServerStripLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div role="region" aria-label="Server name" className="border-b-2 border-rule-2 bg-frame">
      {lines.map((line) => (
        <div key={line} className="cw-marquee-clip flex h-9 items-center overflow-hidden">
          <div className="cw-marquee flex w-max" style={{ animationDuration: `${marqueeSeconds(line)}s` }}>
            {[false, true].map((dup) => (
              <span key={String(dup)} aria-hidden={dup || undefined} className="whitespace-nowrap pr-24 font-display text-sm uppercase tracking-[0.04em] text-muted">
                {splitLine(line).label} <span className="text-gold">{splitLine(line).name}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
