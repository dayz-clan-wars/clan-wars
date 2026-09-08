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
import { guideLinkFor } from "@/lib/guide-links";
import { Page, PageHead, Body, Panel, PanelBody, Notice, BackLine, SessionLost, btnPrimary, btnSecondary, btnDanger, link, field, fieldLabel, checkbox } from "@/app/components/ui";

export const metadata: Metadata = { title: "Clan Wars — vault", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const badge = "border px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.14em]";
const CODE_PATTERN = `\\d{${VAULT_CODE_DIGITS}}`;
const num = (i: number) => String(i).padStart(2, "0");

export default async function VaultPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const { result } = await searchParams;
  const session = await currentSession();
  if (!session) return <SessionLost next="/clan/vault" />;
  const notice = result ? lookupCopy(VAULT_RESULT_COPY, result) : undefined;
  const view = await vaultFor(session.sub);

  if (typeof view === "string") {
    return (
      <Page>
        <PageHead guide={guideLinkFor("/clan/vault")} kicker="Vault" title="No vault yet" />
        <Body className="flex max-w-[40rem] flex-col gap-4">
          {notice && <Notice>{notice}</Notice>}
          <p className="text-ink-2">{REFUSAL[view]} <a className={link} href="/clan">Your clan</a>.</p>
        </Body>
      </Page>
    );
  }

  const clan = await clanFor(session.sub);
  const officer = typeof clan !== "string" && clan.me.status === "full" && (clan.me.role === "officer" || clan.me.role === "leader");
  const { locks, history } = view;
  let n = 0;

  return (
    <Page>
      <PageHead guide={guideLinkFor("/clan/vault")} kicker="Vault" title={<>Your clan&rsquo;s vault</>} sub={VAULT_INTRO} />
      <Body className="flex max-w-[44rem] flex-col gap-4 lg:gap-6">
        {notice && <Notice>{notice}</Notice>}

        {locks.length === 0 && <p className="text-sm text-ink-2">No locks your rank can see yet.</p>}
        {locks.map((lock) => (
          <Panel key={lock.id} num={num(++n)} title={lock.name} aside={lock.rotatedAt ? `rotated ${when(lock.rotatedAt)}` : `added ${when(lock.createdAt)}`}>
            <PanelBody>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`${badge} border-rule-2 text-ink-2`}>{lock.minRole}</span>
                {lock.changedInGame && <span className={`${badge} border-gold text-gold`}>changed in game?</span>}
                {lock.exposed && <span className={`${badge} border-rust text-rust-2`}>known to an ex-member</span>}
              </div>
              {lock.note && <p className="mt-3 text-sm leading-relaxed text-ink-2">{lock.note}</p>}
              <p className="mt-2 text-xs text-muted">{lock.rotatedAt ? `rotated by ${lock.rotatedBy}` : `added by ${lock.createdBy}`}</p>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <RevealButton lockId={lock.id} />
                {lock.changedInGame && (
                  <form action="/api/vault/confirm" method="post">
                    <input type="hidden" name="lockId" value={lock.id} />
                    <button className={btnSecondary} type="submit">Confirm changed in game</button>
                  </form>
                )}
              </div>
            </PanelBody>

            {officer && (
              <PanelBody className="flex flex-col gap-4 border-t border-rule-2">
                <form className="flex flex-col gap-3" action="/api/vault/edit" method="post">
                  <input type="hidden" name="lockId" value={lock.id} />
                  <label className="block"><span className={fieldLabel}>Name</span><input className={field} name="name" defaultValue={lock.name} required maxLength={VAULT_NAME_MAX} /></label>
                  <label className="block"><span className={fieldLabel}>Note</span><input className={field} name="note" defaultValue={lock.note ?? ""} maxLength={VAULT_NOTE_MAX} /></label>
                  <label className="block"><span className={fieldLabel}>Minimum rank</span>
                    <select className={field} name="minRole" defaultValue={lock.minRole} required>
                      {VAULT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </label>
                  <button className={`${btnSecondary} self-start`} type="submit">Save</button>
                </form>
                <form className="border-t border-rule-2 pt-4" action="/api/vault/rotate" method="post">
                  <input type="hidden" name="lockId" value={lock.id} />
                  <label className="flex items-center gap-3 text-sm text-ink-2"><input type="checkbox" name="confirm" value="yes" required className={checkbox} /> Rotate this lock&rsquo;s code.</label>
                  <button className={`mt-3 ${btnSecondary}`} type="submit">Rotate</button>
                </form>
                <form className="border-t border-rule-2 pt-4" action="/api/vault/delete" method="post">
                  <input type="hidden" name="lockId" value={lock.id} />
                  <label className="flex items-center gap-3 text-sm text-ink-2"><input type="checkbox" name="confirm" value="yes" required className={checkbox} /> Delete this lock.</label>
                  <button className={`mt-3 ${btnDanger}`} type="submit">Delete</button>
                </form>
              </PanelBody>
            )}
          </Panel>
        ))}

        {officer && (
          <>
            <Panel num={num(++n)} title="Add lock">
              <PanelBody>
                <form className="flex flex-col gap-3" action="/api/vault/add" method="post">
                  <label className="block"><span className={fieldLabel}>Name</span><input className={field} name="name" required maxLength={VAULT_NAME_MAX} /></label>
                  <label className="block"><span className={fieldLabel}>Note</span><input className={field} name="note" maxLength={VAULT_NOTE_MAX} /></label>
                  <label className="block"><span className={fieldLabel}>Minimum rank</span>
                    <select className={field} name="minRole" defaultValue="member" required>
                      {VAULT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </label>
                  <label className="block"><span className={fieldLabel}>Code</span><input className={field} name="code" pattern={CODE_PATTERN} inputMode="numeric" title={`${VAULT_CODE_DIGITS} digits`} aria-describedby="code-note" /></label>
                  <p id="code-note" className="-mt-1 text-xs text-muted">{VAULT_CODE_DIGITS} digits. Leave it blank and one is generated.</p>
                  <button className={`${btnPrimary} self-start`} type="submit">Add lock</button>
                </form>
              </PanelBody>
            </Panel>

            <Panel num={num(++n)} title="Rotate all">
              <PanelBody>
                <form action="/api/vault/rotate" method="post">
                  <input type="hidden" name="all" value="yes" />
                  <label className="flex items-center gap-3 text-sm text-ink-2"><input type="checkbox" name="confirm" value="yes" required className={checkbox} /> Rotate every lock in the vault.</label>
                  <button className={`mt-3 ${btnSecondary}`} type="submit">Rotate all</button>
                </form>
              </PanelBody>
            </Panel>
          </>
        )}

        {history !== null && (
          <Panel num={num(++n)} title="History">
            {history.length === 0 ? <PanelBody><p className="text-sm text-ink-2">Nothing yet.</p></PanelBody> : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-ink">
                  <thead><tr className="font-mono text-xs uppercase tracking-[0.18em] text-muted"><th className="px-4 py-3 font-normal lg:px-5">When</th><th className="py-3 pr-3 font-normal">Who</th><th className="py-3 pr-3 font-normal">Action</th><th className="py-3 pr-4 font-normal">Lock</th></tr></thead>
                  <tbody>
                    {history.map((h, i) => (
                      <tr key={i} className="border-t border-rule-2">
                        <td className="px-4 py-2.5 lg:px-5">{when(h.at)}</td>
                        <td className="py-2.5 pr-3">{h.by}</td>
                        <td className="py-2.5 pr-3">{h.action}</td>
                        <td className="py-2.5 pr-4">{h.lockName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        )}

        <BackLine href="/clan">Your clan</BackLine>
      </Body>
    </Page>
  );
}
