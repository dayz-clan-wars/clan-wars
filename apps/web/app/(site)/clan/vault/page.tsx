import type { Metadata } from "next";
import { clanFor, vaultFor, VAULT_NAME_MAX, VAULT_NOTE_MAX } from "@factions/roster";
import { VAULT_CODE_DIGITS } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { REFUSAL } from "@/lib/clan-copy";
import { VAULT_INTRO, VAULT_RESULT_COPY } from "@/lib/vault-copy";
import { VAULT_ROLES } from "@/lib/vault-form";
import { lookupCopy } from "@/lib/copy-lookup";
import { when } from "@/lib/format";
import { RevealButton } from "./reveal-button";

export const metadata: Metadata = { title: "Clan Wars — vault", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";
const field = "mt-1 w-full rounded-md border border-rule bg-ground px-3 py-2 font-mono text-ink";
const small = "min-h-[44px] rounded-md border border-rule px-3 font-display text-sm text-ink";
const badge = "rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]";
const CODE_PATTERN = `\\d{${VAULT_CODE_DIGITS}}`;

export default async function VaultPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const { result } = await searchParams;
  const session = await currentSession();
  if (!session) {
    return <main className="mx-auto max-w-[40rem] px-4 py-10"><p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/clan/vault">Sign in again</a>.</p></main>;
  }
  const notice = result ? lookupCopy(VAULT_RESULT_COPY, result) : undefined;
  const view = await vaultFor(session.sub);

  if (typeof view === "string") {
    return (
      <main className="mx-auto max-w-[40rem] px-4 py-10">
        <p className={label}>Vault</p>
        {notice && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{notice}</p>}
        <p className="mt-6 text-ink-2">{REFUSAL[view]} <a className="text-gold underline-offset-4 hover:underline" href="/clan">Your clan</a>.</p>
      </main>
    );
  }

  const clan = await clanFor(session.sub);
  const officer = typeof clan !== "string" && clan.me.status === "full" && (clan.me.role === "officer" || clan.me.role === "leader");
  const { locks, history } = view;

  return (
    <main className="mx-auto max-w-[40rem] px-4 py-10">
      <p className={label}>Vault</p>
      <h1 className="mt-1 font-display text-3xl text-ink">Your clan&rsquo;s vault</h1>
      <p className="mt-3 text-sm text-ink-2">{VAULT_INTRO}</p>
      {notice && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{notice}</p>}

      <ul className="mt-6 flex flex-col gap-4">
        {locks.map((lock) => (
          <li key={lock.id} className="rounded-lg border border-rule bg-frame p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display text-lg text-ink">{lock.name}</span>
              <span className={`${badge} border-rule-2 text-ink-2`}>{lock.minRole}</span>
              {lock.changedInGame && <span className={`${badge} border-gold text-gold`}>changed in game?</span>}
              {lock.exposed && <span className={`${badge} border-rust text-rust`}>known to an ex-member</span>}
            </div>
            {lock.note && <p className="mt-2 text-sm text-ink-2">{lock.note}</p>}
            <p className="mt-2 text-xs text-ink-2">{lock.rotatedAt ? `rotated ${when(lock.rotatedAt)} by ${lock.rotatedBy}` : `added ${when(lock.createdAt)} by ${lock.createdBy}`}</p>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <RevealButton lockId={lock.id} />
              {lock.changedInGame && (
                <form action="/api/vault/confirm" method="post">
                  <input type="hidden" name="lockId" value={lock.id} />
                  <button className={small} type="submit">Confirm changed in game</button>
                </form>
              )}
            </div>

            {officer && (
              <div className="mt-4 flex flex-col gap-3 border-t border-rule-2 pt-4">
                <form className="flex flex-col gap-2" action="/api/vault/edit" method="post">
                  <input type="hidden" name="lockId" value={lock.id} />
                  <label className="block"><span className={label}>Name</span><input className={field} name="name" defaultValue={lock.name} required maxLength={VAULT_NAME_MAX} /></label>
                  <label className="block"><span className={label}>Note</span><input className={field} name="note" defaultValue={lock.note ?? ""} maxLength={VAULT_NOTE_MAX} /></label>
                  <label className="block"><span className={label}>Minimum rank</span>
                    <select className={field} name="minRole" defaultValue={lock.minRole} required>
                      {VAULT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </label>
                  <button className={`${small} self-start`} type="submit">Save</button>
                </form>
                <form action="/api/vault/rotate" method="post">
                  <input type="hidden" name="lockId" value={lock.id} />
                  <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" name="confirm" value="yes" className="h-5 w-5" /> Rotate this lock&rsquo;s code.</label>
                  <button className={`${small} mt-2`} type="submit">Rotate</button>
                </form>
                <form action="/api/vault/delete" method="post">
                  <input type="hidden" name="lockId" value={lock.id} />
                  <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" name="confirm" value="yes" className="h-5 w-5" /> Delete this lock.</label>
                  <button className="mt-2 min-h-[44px] rounded-md border border-rust px-3 font-display text-sm text-ink" type="submit">Delete</button>
                </form>
              </div>
            )}
          </li>
        ))}
        {locks.length === 0 && <p className="text-sm text-ink-2">No locks your rank can see yet.</p>}
      </ul>

      {officer && (
        <>
          <section className="mt-6 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Add lock</h2>
            <form className="mt-2 flex flex-col gap-3" action="/api/vault/add" method="post">
              <label className="block"><span className={label}>Name</span><input className={field} name="name" required maxLength={VAULT_NAME_MAX} /></label>
              <label className="block"><span className={label}>Note</span><input className={field} name="note" maxLength={VAULT_NOTE_MAX} /></label>
              <label className="block"><span className={label}>Minimum rank</span>
                <select className={field} name="minRole" defaultValue="member" required>
                  {VAULT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label className="block"><span className={label}>Code</span><input className={field} name="code" pattern={CODE_PATTERN} inputMode="numeric" placeholder="leave blank to generate" /></label>
              <button className="min-h-[44px] self-start rounded-md bg-gold px-4 font-display text-ground" type="submit">Add lock</button>
            </form>
          </section>

          <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Rotate all</h2>
            <form className="mt-2" action="/api/vault/rotate" method="post">
              <input type="hidden" name="all" value="yes" />
              <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" name="confirm" value="yes" className="h-5 w-5" /> Rotate every lock in the vault.</label>
              <button className={`${small} mt-2`} type="submit">Rotate all</button>
            </form>
          </section>
        </>
      )}

      {history !== null && (
        <section className="mt-6 rounded-lg border border-rule bg-frame p-5">
          <h2 className={label}>History</h2>
          {history.length === 0 ? <p className="mt-2 text-sm text-ink-2">Nothing yet.</p> : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-sm text-ink">
                <thead><tr className="text-xs text-ink-2"><th className="pr-3">When</th><th className="pr-3">Who</th><th className="pr-3">Action</th><th>Lock</th></tr></thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={i} className="border-t border-rule-2">
                      <td className="py-1 pr-3">{when(h.at)}</td>
                      <td className="py-1 pr-3">{h.by}</td>
                      <td className="py-1 pr-3">{h.action}</td>
                      <td className="py-1">{h.lockName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/clan">Your clan</a></p>
    </main>
  );
}
