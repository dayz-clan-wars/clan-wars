import type { Metadata } from "next";
import { clanFor, vaultFor } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { REFUSAL } from "@/lib/clan-copy";
import { VAULT_INTRO, VAULT_RESULT_COPY } from "@/lib/vault-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { readKept } from "@/lib/form";
import { when, ago } from "@/lib/format";
import { RevealButton } from "./reveal-button";
import { AddLockForm, Chevron, LockEditor, fold } from "./lock-forms";
import { editingIdFor } from "@/lib/vault-form";
import { guideLinkFor } from "@/lib/guide-links";
import { fieldError } from "@/lib/field-errors";
import { OwnClanHero } from "@/app/components/own-clan-hero";
import { Page, PageHead, Body, PanelBody, Notice, BackLine, SessionLost, ConfirmButton, SubmitButton, btnSecondary, link } from "@/app/components/ui";

export const metadata: Metadata = { title: "Clan Wars — vault", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const badge = "border px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.14em]";
const num = (i: number) => String(i).padStart(2, "0");
const ID_RE = /^\d{1,12}$/u;

/**
 * The vault (App Review §02): every lock is a collapsed card — name, rank,
 * flags, Reveal in front — with the officer's edit form folded behind
 * "Edit". Rotate and Delete are two-press. Add lock and History fold too,
 * so five locks is one screen, not five.
 */
export default async function VaultPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const result = typeof q.result === "string" ? q.result : undefined;
  const session = await currentSession();
  if (!session) return <SessionLost next="/clan/vault" />;
  const notice = result ? lookupCopy(VAULT_RESULT_COPY, result) : undefined;
  // Only the Add form's refusals name a field; an edit's refusal is shown inside its own lock (M11).
  const err = fieldError(result, VAULT_RESULT_COPY);
  // ⚠️ readKept never returns `code` (lib/form.ts NEVER_KEEP): nothing on this page can refill one.
  const kept = readKept(q);
  // L9: the hero's clan read runs BESIDE the vault's own, not after it. It is still two
  // reads (vaultFor answers only for the vault); what this removes is the serial wait.
  const [view, clan] = await Promise.all([vaultFor(session.sub), clanFor(session.sub)]);

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

  const officer = typeof clan !== "string" && clan.me.status === "full" && (clan.me.role === "officer" || clan.me.role === "leader");
  const { locks, history } = view;
  const keptLock = { name: kept.get("name"), note: kept.get("note"), minRole: kept.get("minRole") };
  // H2: the Add form stays open, with what was typed, after any refusal of an add.
  const addRefused = result !== undefined && result.startsWith("add.") && result !== "add.ok";
  const addOpen = err !== null || addRefused;
  // M11: an edit's refusal carries its lock id. That lock's editor opens with the sentence
  // inside it; a lock that has since gone (deleted by another officer) falls back to the top notice.
  const lockParam = kept.get("lock");
  const editRefused = result !== undefined && /^(edit|input)\./u.test(result) && lockParam !== undefined && ID_RE.test(lockParam);
  // ⚠️ `officer` gates this: LockEditor only renders under `officer` below, so without the
  // check here a demoted-officer or crafted-query refusal would suppress the top notice
  // (editingId !== null) while rendering no editor to show it in. See lib/vault-form.ts.
  const editingId = editingIdFor(officer, editRefused, lockParam, locks);

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
        {notice && editingId === null && <Notice focus={err === null}>{notice}</Notice>}

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
                  <SubmitButton className="flex min-h-[48px] items-center px-4 font-mono text-[11px] uppercase tracking-[0.18em] text-gold hover:text-ink">Confirm changed</SubmitButton>
                </form>
              )}
            </div>
            {officer && (
              <LockEditor lock={lock} open={editingId === lock.id}
                error={editingId === lock.id ? notice : undefined} kept={editingId === lock.id ? keptLock : undefined} />
            )}
          </section>
        ))}

        {officer && (
          <div className="grid gap-2 sm:grid-cols-2">
            <AddLockForm err={err} kept={addRefused ? keptLock : {}} open={addOpen} />
            <form action="/api/vault/rotate" method="post" className="sm:col-span-2">
              <input type="hidden" name="all" value="yes" />
              <input type="hidden" name="confirm" value="yes" />
              <ConfirmButton confirm="Press again to rotate all" className={`${btnSecondary} w-full`}>Rotate all</ConfirmButton>
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
                        <td className="py-2.5 pr-3">{h.by ?? "a member"}</td>
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
