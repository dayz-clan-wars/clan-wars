import type { ClanView } from "@factions/roster";
import { when } from "@/lib/format";
import { PanelBody } from "@/app/components/ui";
import { RowAction } from "@/app/components/row-action";

/**
 * The open guest passes on /clan/settings.
 *
 * M5: a pass is named by the guest's gamertag. An unlinked guest has no name
 * the site knows, so they read "Discord user" with the id beside it, muted —
 * the id is the one thing that tells two unlinked guests apart.
 */
export function GuestPassList({ passes }: { passes: ClanView["guestPasses"] }) {
  if (passes.length === 0) return <PanelBody className="border-t border-rule-2 !py-3"><p className="text-sm text-ink-2">No open passes.</p></PanelBody>;
  return (
    <ul className="border-t border-rule-2">
      {passes.map((p) => (
        <li key={p.id} className="flex min-h-[60px] flex-wrap items-center justify-between gap-3 border-t border-rule-2 px-4 py-2 text-sm text-ink first:border-t-0 lg:px-5">
          <span>
            <span className="font-mono">{p.userGamertag ?? "Discord user"}</span>
            {p.userGamertag === null && <span className="ml-2 font-mono text-xs text-muted">{p.userDiscordId}</span>}
            <span className="block text-xs text-muted">granted by {p.grantedBy} · expires {when(p.expiresAt)}</span>
          </span>
          <RowAction action="/api/clan/revoke-guest" fields={{ passId: p.id }} who={p.userGamertag ?? "Discord user"} confirm="Press again to revoke">Revoke</RowAction>
        </li>
      ))}
    </ul>
  );
}
