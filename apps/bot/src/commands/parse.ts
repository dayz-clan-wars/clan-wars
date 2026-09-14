import type { DirectoryEntry, Role, StatScope } from "@factions/roster";

/**
 * Slash command options only carry strings (autocomplete choices are
 * strings even for a row that is really a number), but every roster call
 * that takes a row id wants a number. `idOf` is the one place that bridges
 * the two: null for missing/blank input, null for anything that is not a
 * positive integer, otherwise the parsed number.
 *
 * ⚠️ Matched against a decimal regex, NOT `Number()`. `Number("9e2")` is
 * 900 and `Number("0x10")` is 16, and both pass `Number.isInteger`, so a
 * bare coercion silently accepts input this function's own doc comment says
 * it rejects. It matters because these strings are player-typed: an option
 * marked `setAutocomplete(true)` still sends whatever the player typed
 * instead of picking, so every `lock:`, `pin:`, `invite:` and `pass:` on
 * the branch reaches here as arbitrary text. No privilege escalation — the
 * roster re-derives permission from the actor and answers "gone" for a row
 * that is not theirs — but `DECIMAL_RE` in `config.ts` is the house rule and
 * PLAN-3-INBOX item 16 exists because two older parsers broke it the same
 * way.
 */
const DECIMAL_RE = /^\d+$/u;

export function idOf(raw: string | null): number | null {
  if (!raw || !DECIMAL_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const ROLES: readonly Role[] = ["leader", "officer", "member"];

/**
 * A role name off a slash choice or a custom id's `arg`, or null.
 *
 * ⚠️ Validated rather than cast: `arg` is client-supplied data that has
 * round-tripped through Discord, and it decides which ranks can read a lock.
 */
export function roleOf(raw: string | null): Role | null {
  return ROLES.find((r) => r === raw) ?? null;
}

/**
 * R7: one `scope:` option, autocompleted to `current`, `all` and each closed
 * season's number. Unrecognised input resolves to the current season rather
 * than throwing — the string comes from a client and every read echoes back
 * the scope it actually resolved, so a wrong guess is visible, not silent.
 */
export function parseScope(raw: string | null): StatScope {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "all") return { kind: "all" };
  if (/^[1-9]\d*$/u.test(v)) return { kind: "season", number: Number(v) };
  return { kind: "current" };
}

/**
 * The directory, filtered case-insensitively by name or tag — the FILTERING
 * three autocomplete sources share (`/clans`'s, `/warlog`'s, and `/achievements
 * clan:`'s). Their LABELS differ (`/clans` alone appends "· recruiting"), so
 * only this is shared; each call site still builds its own `{ name, value }`.
 */
export function matchClans(clans: readonly DirectoryEntry[], query: string): DirectoryEntry[] {
  const q = query.trim().toLowerCase();
  return clans.filter((c) => q === "" || c.tag.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
}
