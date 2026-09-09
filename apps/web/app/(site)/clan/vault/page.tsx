import type { Metadata } from "next";
import { clanFor, vaultFor, VAULT_NAME_MAX, VAULT_NOTE_MAX } from "@factions/roster";
import { VAULT_CODE_DIGITS } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { REFUSAL } from "@/lib/clan-copy";
import { VAULT_INTRO, VAULT_RESULT_COPY } from "@/lib/vault-copy";
import { VAULT_ROLES } from "@/lib/vault-form";
import { lookupCopy } from "@/lib/copy-lookup";
import { when, ago } from "@/lib/format";
import { RevealButton } from "./reveal-button";
import { guideLinkFor } from "@/lib/guide-links";
import { fieldError } from "@/lib/field-errors";
import { OwnClanHero } from "@/app/components/own-clan-hero";
import { Page, PageHead, Body, PanelBody, Notice, BackLine, SessionLost, ConfirmButton, FieldError, invalid, btnPrimary, btnSecondary, btnDanger, link, field, fieldLabel } from "@/app/components/ui";

export const metadata: Metadata = { title: "Clan Wars — vault", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const badge = "border px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.14em]";
const CODE_PATTERN = `\\d{${VAULT_CODE_DIGITS}}`;
const num = (i: number) => String(i).padStart(2, "0");
/** A fold's head: the mono caption with a chevron, 48px, full width. */
const fold = "flex min-h-[48px] cursor-pointer list-none items-center justify-between gap-3 px-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-ink [&::-webkit-details-marker]:hidden";
const Chevron = () => <><span aria-hidden="true" className="group-open:hidden">▾</span><span aria-hidden="true" className="hidden group-open:inline">▴</span></>;

/**
 * The vault (App Review §02): every lock is a collapsed card — name, rank,
 * flags, Reveal in front — with the officer's edit form folded behind
 * "Edit". Rotate and Delete are two-press. Add lock and History fold too,
 * so five locks is one screen, not five.
 */
export default async function VaultPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const { result } = await searchParams;
  const session = await currentSession();
  if (!session) return <SessionLost next="/clan/vault" />;
  const notice = result ? lookupCopy(VAULT_RESULT_COPY, result) : undefined;
  // Only the Add form's refusals name a field: an edit's would need the lock id to find its form.
  const err = fieldError(result, VAULT_RESULT_COPY);
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
  // The Add form stays open when a refusal named one of its fields.
  const addOpen = err !== null;

  return (
    <Page wide>
      {typeof clan === "string"
        ? <PageHead guide={guideLinkFor("/clan/vault")} kicker="Vault" title={<>Your clan&rsquo;s vault</>} sub={VAULT_INTRO} />
        : <OwnClanHero view={clan} current="vault" guide={guideLinkFor("/clan/vault")} />}
      <Body className="flex max-w-[44rem] flex-col gap-3 lg:gap-4">
        <div>
          <h2 className="font-display text-sm uppercase tracking-[0.06em] text-ink">Your clan&rsquo;s vault</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{VAULT_INTRO}</p>
        </div>
        {notice && <Notice focus={err === null}>{notice}</Notice>}

        {locks.length === 0 && <p className="text-sm text-ink-2">No locks your rank can see yet.</p>}
        {locks.map((lock, i) => (
          <section key={lock.id} className="border-2 border-rule-2 bg-frame" aria-label={lock.name}>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3 lg:px-5">
              <span className="font-mono text-[11px] text-gold">{num(i + 1)}</span>
              <h2 className="m-0 flex-1 font-display text-sm uppercase tracking-[0.06em] text-ink">{lock.name}</h2>
              <span className={`${badge} border-rule-2 text-ink-2`}>{lock.minRole}</span>
              {lock.changedInGame && <span className={`${badge} border-gold text-gold`}>changed in game?</span>}
              {lock.exposed && <span className={`${badge} border-rust text-rust-2`}>ex-member knows</span>}
            </div>
            {(lock.note || lock.rotatedAt || lock.createdAt) && (
              <p className="m-0 px-4 pb-3 text-[13px] leading-relaxed text-ink-2 lg:px-5">
                {lock.note && <>{lock.note} </>}
                <span className="text-muted">{lock.rotatedAt ? `rotated ${ago(lock.rotatedAt)} by ${lock.rotatedBy}` : `added ${ago(lock.createdAt)} by ${lock.createdBy}`}</span>
              </p>
            )}
            <div className="flex items-stretch border-t border-rule-2">
              <RevealButton lockId={lock.id} className="flex min-h-[48px] w-full items-center justify-center bg-gold font-display text-xs uppercase tracking-[0.06em] text-ground hover:bg-gold-hover disabled:opacity-40" />
              {lock.changedInGame && (
                <form action="/api/vault/confirm" method="post" className="flex flex-none border-l border-rule-2">
                  <input type="hidden" name="lockId" value={lock.id} />
                  <button className="flex min-h-[48px] items-center px-4 font-mono text-[11px] uppercase tracking-[0.18em] text-gold hover:text-ink" type="submit">Confirm changed</button>
                </form>
              )}
            </div>
            {officer && (
              <details className="group border-t border-rule-2">
                <summary className={fold}>Edit <Chevron /></summary>
                <div className="flex flex-col gap-4 border-t-2 border-rule-2 bg-surface p-4 lg:p-5">
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
                  <div className="grid grid-cols-2 gap-2 border-t border-rule-2 pt-4">
                    <form action="/api/vault/rotate" method="post" className="contents">
                      <input type="hidden" name="lockId" value={lock.id} />
                      <input type="hidden" name="confirm" value="yes" />
                      <ConfirmButton confirm="Rotate it?" className={`${btnSecondary} w-full`}>Rotate code</ConfirmButton>
                    </form>
                    <form action="/api/vault/delete" method="post" className="contents">
                      <input type="hidden" name="lockId" value={lock.id} />
                      <input type="hidden" name="confirm" value="yes" />
                      <ConfirmButton confirm="Delete it?" className={`${btnDanger} w-full`}>Delete</ConfirmButton>
                    </form>
                  </div>
                  <p className="m-0 font-mono text-[11px] leading-relaxed text-muted">Rotate and Delete are two-press: the first tap arms, the second within 4 s does it. Rotating here does not change the lock in the game.</p>
                </div>
              </details>
            )}
          </section>
        ))}

        {officer && (
          <div className="grid gap-2 sm:grid-cols-2">
            <details className="group border-2 border-rule-2 bg-frame sm:col-span-2" open={addOpen}>
              <summary className={`${fold} !text-ink`}>+ Add lock <Chevron /></summary>
              <form className="flex flex-col gap-3 border-t-2 border-rule-2 p-4 lg:p-5" action="/api/vault/add" method="post">
                <label className="block"><span className={fieldLabel}>Name</span><input {...invalid(err, "name")} className={`${field} ${invalid(err, "name").className ?? ""}`} name="name" required maxLength={VAULT_NAME_MAX} /><FieldError err={err} name="name" /></label>
                <label className="block"><span className={fieldLabel}>Note</span><input {...invalid(err, "note")} className={`${field} ${invalid(err, "note").className ?? ""}`} name="note" maxLength={VAULT_NOTE_MAX} /><FieldError err={err} name="note" /></label>
                <label className="block"><span className={fieldLabel}>Minimum rank</span>
                  <select className={field} name="minRole" defaultValue="member" required>
                    {VAULT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </label>
                <label className="block"><span className={fieldLabel}>Code</span><input {...invalid(err, "code")} className={`${field} ${invalid(err, "code").className ?? ""}`} name="code" pattern={CODE_PATTERN} inputMode="numeric" title={`${VAULT_CODE_DIGITS} digits`} aria-describedby={err?.field === "code" ? "err-code code-note" : "code-note"} /><FieldError err={err} name="code" /></label>
                <p id="code-note" className="-mt-1 text-xs text-muted">{VAULT_CODE_DIGITS} digits. Leave it blank and one is generated.</p>
                <button className={`${btnPrimary} self-start`} type="submit">Add lock</button>
              </form>
            </details>
            <form action="/api/vault/rotate" method="post" className="sm:col-span-2">
              <input type="hidden" name="all" value="yes" />
              <input type="hidden" name="confirm" value="yes" />
              <ConfirmButton confirm="Rotate every lock?" className={`${btnSecondary} w-full`}>Rotate all</ConfirmButton>
            </form>
          </div>
        )}

        {history !== null && (
          <details className="group border-2 border-rule-2 bg-frame">
            <summary className={`${fold} !text-ink`}>History <span className="ml-auto font-mono text-[11px] normal-case tracking-[0.18em] text-muted">{history.length} {history.length === 1 ? "entry" : "entries"}</span> <Chevron /></summary>
            {history.length === 0 ? <PanelBody className="border-t-2 border-rule-2"><p className="text-sm text-ink-2">Nothing yet.</p></PanelBody> : (
              <div className="overflow-x-auto border-t-2 border-rule-2">
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
          </details>
        )}

        <BackLine href="/clan">Your clan</BackLine>
      </Body>
    </Page>
  );
}
