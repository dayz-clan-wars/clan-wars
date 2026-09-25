import type { DirectoryEntry } from "@factions/roster";
import { flagThumbPath } from "@/src/flag-images";
import { ALPHA_BADGE } from "@/lib/scoring-copy";
import { Facts, kickerSm } from "@/app/components/ui";

const href = (tag: string) => `/clans/${encodeURIComponent(tag)}`;

/**
 * ⚠️ `min-w-0` AND `[overflow-wrap:anywhere]` on every name here (M11). A
 * clan name can be CLAN_NAME_LENGTH.max characters with no space, wider than
 * a phone in Archivo Black; without min-w-0 the flex item refuses to shrink
 * below that word, and without overflow-wrap it cannot break once it does.
 * Everything else in the row is `flex-none`, so only the name gives.
 */
const NAME = "min-w-0 [overflow-wrap:anywhere]";

/** One recruiting clan: the row, then its play window, language and pitch. */
export function RecruitingRow({ c }: { c: DirectoryEntry }) {
  return (
    <li className="border-t border-rule-2 px-4 py-3.5 first:border-t-0 lg:px-5 lg:py-4">
      <a className="flex items-center gap-3 text-ink" href={href(c.tag)}>
        <img src={`/${flagThumbPath(c.texture)}`} alt="" loading="lazy" width={40} height={40} className="h-9 w-9 flex-none object-contain lg:h-10 lg:w-10" />
        <span className={`${NAME} font-display text-base lg:text-lg`}>{c.name}</span>
        <span className="hidden flex-none font-mono text-xs text-ink-2 lg:inline">[{c.tag}]</span>
        <span className="ml-auto flex-none font-mono text-[11px] text-muted">{c.memberCount} members</span>
      </a>
      {(c.playWindow || c.language || c.pitch) && (
        <Facts className="mt-3" items={[
          ...(c.playWindow ? [["Plays", c.playWindow] as [React.ReactNode, React.ReactNode]] : []),
          ...(c.language ? [["Speaks", c.language] as [React.ReactNode, React.ReactNode]] : []),
          ...(c.pitch ? [["Pitch", <span key="p" className="text-ink">{c.pitch}</span>] as [React.ReactNode, React.ReactNode]] : []),
        ]} />
      )}
    </li>
  );
}

/** One clan in "Every clan": flag, name, badges, member count. */
export function ClanRow({ c }: { c: DirectoryEntry }) {
  const dormant = c.status === "dormant";
  return (
    <li className="border-t border-rule-2 first:border-t-0">
      <a className={`flex min-h-[56px] items-center gap-3 px-4 lg:min-h-[60px] lg:gap-3.5 lg:px-5 ${dormant ? "text-ink-2" : "text-ink"}`} href={href(c.tag)}>
        <img src={`/${flagThumbPath(c.texture)}`} alt="" loading="lazy" width={32} height={32} className={`h-7 w-7 flex-none object-contain lg:h-8 lg:w-8 ${dormant ? "opacity-60" : ""}`} />
        <span className={`${NAME} font-display text-[15px] lg:text-base`}>{c.name}</span>
        <span className="hidden flex-none font-mono text-xs text-ink-2 lg:inline">[{c.tag}]</span>
        {c.alpha && <span className={`${kickerSm} flex-none !text-gold`}>{ALPHA_BADGE}</span>}
        {dormant && <span className={`${kickerSm} flex-none`}>dormant</span>}
        <span className="ml-auto flex-none font-mono text-[13px] tabular-nums text-ink-2">{c.memberCount}</span>
      </a>
    </li>
  );
}
