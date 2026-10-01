import type { Line, Seg } from "@factions/copy";
import { when } from "@/lib/format";
import { link } from "@/app/components/ui";

/** A shared copy Line as JSX: the site's half of what the bot does with lineMarkdown. */
export function Rich({ line }: { line: Line }) {
  return <>{line.map((s, i) => <Part key={i} s={s} />)}</>;
}

function Part({ s }: { s: Seg }) {
  if (typeof s === "string") return <>{s}</>;
  if ("text" in s) return <>{s.text}</>;
  if ("raw" in s) return <>{s.raw}</>;
  if ("bold" in s) return <strong className="text-ink"><Rich line={s.bold} /></strong>;
  if ("player" in s) return <a className={link} href={`/players/${encodeURIComponent(s.player)}`}>{s.player}</a>;
  if ("clan" in s) {
    const a = <a className={link} href={`/clans/${encodeURIComponent(s.clan)}`}>{s.name ?? s.clan}</a>;
    return s.name ? <><strong className="text-ink">{a}</strong> [{s.clan}]</> : a;
  }
  if ("time" in s) return <time dateTime={s.time}>{when(new Date(s.time))}</time>;
  return <a className={link} href={s.page}>{s.label}</a>;
}
