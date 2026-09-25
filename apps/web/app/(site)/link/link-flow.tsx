"use client";

import { useEffect, useRef, useState } from "react";
import { LINK_EMOTES } from "@factions/domain";
import type { IssueOutcome, LinkStatus } from "@factions/roster";
import { ENDED_COPY, ISSUE_COPY, LINK_FAILED, LINK_UNSEEN, formatRemaining } from "@/lib/link-copy";
import { readJson, resolveTyped, type Match } from "@/lib/link-claim";
import { visiblePoll } from "@/lib/visible-poll";
import { when } from "@/lib/format";
import { btnCta, btnQuiet, btnSecondary, field } from "@/app/components/ui";

/** `LinkStatus` after a trip through JSON: every Date is an ISO string. */
type Wire<T> = T extends Date ? string : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;
type Status = Wire<LinkStatus>;
type Outcome = Wire<IssueOutcome>;

const POLL_MS = 5_000;

const spread = "grid gap-6 px-5 py-6 lg:grid-cols-2 lg:gap-16 lg:px-8 lg:py-14";
const step = "font-mono text-[11px] uppercase tracking-[0.18em] text-muted";
const h1 = "mt-3 font-display text-[40px] uppercase leading-[.9] tracking-[-0.02em] text-ink lg:mt-4 lg:text-[64px]";
const body = "mt-4 max-w-[480px] text-[15px] leading-relaxed text-ink-2 [text-wrap:pretty] lg:mt-6 lg:text-[17px]";
const card = "border-2 border-rule-2 bg-frame p-5 lg:self-start";
const label = step;
const button = `w-full ${btnCta}`;
const quiet = btnQuiet;

export function LinkFlow({ initial }: { initial: Status }) {
  const [status, setStatus] = useState<Status>(initial);
  const [notice, setNotice] = useState<string | null>(initial.ended ? ENDED_COPY[initial.ended] : null);
  const [busy, setBusy] = useState(false);

  // ⚠️ M1: every answer on this page is read through readJson (lib/link-claim.ts).
  // A 500, a dead connection or a lapsed session's HTML used to throw out of
  // these handlers, and the player saw nothing happen at all.
  const refresh = async () => {
    const res = await fetch("/api/link/status", { cache: "no-store" }).catch(() => null);
    if (res?.status === 401) { window.location.assign("/login?next=/link"); return; }
    const next = await readJson<Status>(res);
    if (!next) return;
    setStatus((prev) => {
      // A challenge that vanished between polls ended without us: say why.
      if (prev.challenge && !next.challenge && !next.link && next.ended) setNotice(ENDED_COPY[next.ended]);
      return next;
    });
  };

  // ⚠️ Poll only while a challenge is open. Emotes reach the database in the
  // bot's tick batches, so a confirmation lands seconds to a minute behind
  // the emote; five seconds is often enough to feel live without hammering.
  useEffect(() => {
    if (!status.challenge) return undefined;
    // L9: paused while the tab is hidden; the player is in game performing the emotes.
    return visiblePoll(document, () => { void refresh(); }, POLL_MS);
  }, [status.challenge?.id]);

  const start = async (dayzId: string, newSequence = false) => {
    setBusy(true);
    try {
      const res = await fetch("/api/link/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dayzId, newSequence }) }).catch(() => null);
      if (res?.status === 401) { window.location.assign("/login?next=/link"); return; }
      const data = await readJson<{ outcome: Outcome }>(res);
      if (!data) { setNotice(LINK_FAILED); return; }
      const { outcome } = data;
      if (outcome.kind === "issued" || outcome.kind === "live") {
        setNotice(outcome.kind === "issued" && outcome.switchedFrom
          ? `Canceled your challenge for ${outcome.switchedFrom} — that sequence no longer works. Here is the new one.`
          : null);
        await refresh();
      } else {
        const endsWhen = outcome.kind === "held-by-other" ? when(new Date(outcome.expiresAt)) : undefined;
        setNotice(ISSUE_COPY[outcome.kind](outcome as unknown as IssueOutcome, endsWhen));
      }
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/link/cancel", { method: "POST" }).catch(() => null);
      if (res?.status === 401) { window.location.assign("/login?next=/link"); return; }
      // ⚠️ M1: a cancel the server did not take must not read as done — the old sequence still works.
      if (!res?.ok) { setNotice(LINK_FAILED); return; }
      setNotice(null);
      await refresh();
    } finally { setBusy(false); }
  };

  if (status.link) return <Verified gamertag={status.link.gamertag} verifiedAt={status.link.verifiedAt} />;
  if (status.challenge) {
    return <ProveIt challenge={status.challenge} notice={notice} busy={busy}
      onDraw={() => start(currentTarget(status), true)} onCancel={cancel} />;
  }
  return <ChooseCharacter notice={notice} busy={busy} onClaim={(dayzId) => start(dayzId)} />;
}

/** The open challenge's target, for the re-roll. Read from status so the client never guesses a UID. */
function currentTarget(status: Status): string {
  return status.challenge?.targetDayzId ?? "";
}

function ChooseCharacter({ notice, busy, onClaim }: { notice: string | null; busy: boolean; onClaim: (dayzId: string) => void }) {
  const [query, setQuery] = useState("");
  /** The list on screen AND the text it was fetched for — without `q`, a stale list reads as a verdict (H5). */
  const [shown, setShown] = useState<{ q: string; matches: Match[] }>({ q: "", matches: [] });
  const [denial, setDenial] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const matches = shown.matches;

  const search = async (q: string): Promise<Match[] | null> => {
    const res = await fetch(`/api/link/search?q=${encodeURIComponent(q)}`, { cache: "no-store" }).catch(() => null);
    return (await readJson<{ matches: Match[] }>(res))?.matches ?? null;
  };

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (!q) { setShown({ q: "", matches: [] }); return; }
    timer.current = setTimeout(async () => {
      const found = await search(q);
      if (found) setShown({ q, matches: found });
    }, 200);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query]);

  /**
   * ⚠️ Resolved from the typed text on submit, not from whatever row was last
   * clicked — autocomplete is a suggestion, and the package re-validates the
   * UID anyway. A full gamertag typed without touching the list still works,
   * because resolveTyped searches again when the list is for older text (H5).
   */
  const claim = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || checking || !query.trim()) return;
    setChecking(true);
    try {
      const r = await resolveTyped(query, shown, search);
      if (r.kind === "found") { setDenial(null); onClaim(r.dayzId); }
      else setDenial(r.kind === "unseen" ? LINK_UNSEEN : LINK_FAILED);
    } finally { setChecking(false); }
  };

  return (
    <div className={spread}>
      <div>
        <div className={step}>Step 2 of 3 — name your character</div>
        <h1 className={h1}>Which one is you?</h1>
        <p className={body}>The gamertag you play under. Only characters the server has actually seen are listed — if yours is missing, play a session first.</p>
        <p className="mt-4 hidden font-mono text-[11px] leading-relaxed text-muted lg:block">One character per Discord account. You will prove it is you with {LINK_EMOTES} emotes in game.</p>
      </div>
      {/* ⚠️ H5: a real form, so Enter in the box claims — it did nothing when the input sat outside one. */}
      <form className={card} onSubmit={(e) => { void claim(e); }}>
        {(notice || denial) && <Refusal label="Not issued">{denial ?? notice}</Refusal>}
        <input className={field.replace("mt-1", "")} value={query}
          onChange={(e) => { setQuery(e.target.value); setDenial(null); }} placeholder="Gamertag" aria-label="Gamertag" autoComplete="off" spellCheck={false} />
        {/* Plain buttons in a list, not a listbox: a listbox's options cannot be focusable buttons, and Tab-then-Enter is what a keyboard user will do here. */}
        <p role="status" className="sr-only">{query.trim() ? `${matches.length} ${matches.length === 1 ? "character" : "characters"} found` : ""}</p>
        {query.trim() && matches.length === 0 && <p className="mt-2 px-2 py-2 font-mono text-xs text-muted">No unclaimed character by that name</p>}
        {matches.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1" aria-label="Characters the server has seen">
            {matches.map((m) => {
              const picked = m.gamertag.toLowerCase() === query.trim().toLowerCase();
              return (
                <li key={m.dayzId}>
                  <button type="button" aria-pressed={picked}
                    className={`flex min-h-[44px] w-full items-center px-3 text-left font-mono text-ink hover:bg-surface ${picked ? "bg-surface" : ""}`} onClick={() => setQuery(m.gamertag)}>
                    {m.gamertag}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {/* ⚠️ aria-disabled while checking, not disabled: a disabled button drops the focus it was just pressed with. */}
        <button className={`mt-5 ${button} aria-disabled:opacity-40`} type="submit" disabled={busy || !query.trim()} aria-disabled={checking || undefined} aria-busy={checking || undefined}>
          {checking ? "Checking…" : <>Claim it <span className="font-mono normal-case">→</span></>}
        </button>
        <div className="mt-4 font-mono text-[11px] leading-relaxed text-muted lg:hidden">One character per Discord account. You will prove it is you with {LINK_EMOTES} emotes in game.</div>
      </form>
    </div>
  );
}

function ProveIt({ challenge, notice, busy, onDraw, onCancel }: {
  challenge: NonNullable<Status["challenge"]>; notice: string | null; busy: boolean; onDraw: () => void; onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const remaining = new Date(challenge.expiresAt).getTime() - now;
  const total = challenge.steps.length;

  const draws = challenge.drawsLeft > 0
    ? `Can’t find one of these on the wheel? Draw a new sequence — ${challenge.drawsLeft} ${challenge.drawsLeft === 1 ? "draw" : "draws"} left today.`
    : "Out of draws for this character today. If an emote is missing from your wheel, say so in the Discord rather than working around it.";

  return (
    <div className={spread}>
      <div>
        <div className={step}>Step 3 of 3 — prove it</div>
        <h1 className={h1}>Prove it&rsquo;s you.</h1>
        <div className="mt-3 font-mono text-lg text-gold lg:mt-4 lg:text-xl">{challenge.gamertag}</div>
        <p className={body}>In game as that character, open the emote wheel and perform these {total}, in this order. Other emotes in between are fine — the order is what counts.</p>
        <dl className="mt-6 hidden max-w-[480px] grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm leading-relaxed text-ink-2 lg:grid">
          <dt className={`${step} pt-1`}>Timing</dt><dd className="m-0">Emotes reach us from the server log in batches, so a confirmation can take up to a minute to appear. This page checks every few seconds.</dd>
          <dt className={`${step} pt-1`}>Log off</dt><dd className="m-0">Perform all {LINK_EMOTES} and you can log off — the link catches up on its own.</dd>
        </dl>
      </div>
      {/* Rust: an obligation the player still owes the server (frontend rebuild §4). */}
      <div className="border-2 border-rust bg-frame lg:self-start">
        <div className="flex items-center justify-between gap-4 border-b-2 border-rust px-4 py-3 lg:px-5">
          <h2 className="m-0 font-display text-[13px] uppercase tracking-[0.06em] text-ink lg:text-sm"><span aria-hidden="true" className="mr-3 text-rust-2">●</span>Challenge open</h2>
          <span className="font-mono text-[11px] text-muted"><span className="hidden lg:inline">Expires in </span>{formatRemaining(remaining)}<span className="lg:hidden"> left</span></span>
        </div>
        {notice && <div className="px-4 pt-4 lg:px-5"><Refusal label="Note" neutral>{notice}</Refusal></div>}
        {/* ⚠️ An ordered list, because the order IS the proof. */}
        <ol className="flex flex-col gap-2 p-4 lg:gap-2.5 lg:p-5">
          {challenge.steps.map((s, i) => (
            <li key={s.token} className={`flex min-h-[56px] items-center gap-4 border-2 px-4 lg:min-h-[60px] ${s.confirmed ? "border-olive bg-surface" : "border-rule-2"}`}>
              <span className={`font-display text-xl lg:text-[22px] ${s.confirmed ? "text-olive" : "text-dim"}`}>{i + 1}</span>
              <span className={`font-display text-lg lg:text-xl ${s.confirmed ? "text-olive line-through" : "text-ink"}`}>{s.label}</span>
              <span className={`ml-auto font-mono text-[11px] uppercase tracking-[0.18em] ${s.confirmed ? "text-olive" : "text-muted"}`}>{s.confirmed ? "Confirmed" : "Waiting"}</span>
            </li>
          ))}
        </ol>
        {/* ⚠️ A SIBLING of the list, never an attribute on it: aria-live on the <ol> strips list semantics in several screen readers. */}
        <p role="status" aria-live="polite" className="sr-only">{challenge.confirmed} of {total} confirmed</p>
        <div className="mx-4 border border-rule-2 bg-surface px-3.5 py-3 text-sm leading-relaxed text-ink-2 lg:mx-5">
          <strong className="text-ink">The server has confirmed {challenge.confirmed} of {total}.</strong>{" "}
          <span className="lg:hidden">A confirmation can take up to a minute. Perform all {LINK_EMOTES} and you can log off.</span>
          <span className="hidden lg:inline">Emotes reach us from the server log in batches, so a confirmation can take up to a minute to appear. This page checks every few seconds; perform all {LINK_EMOTES} and you can log off — the link catches up on its own.</span>
        </div>
        <div className="mt-4 flex items-center justify-between gap-4 border-t border-rule-2 px-4 py-3.5 lg:px-5 lg:py-4">
          <span className="font-mono text-[11px] leading-relaxed text-muted">{draws}</span>
          <span className="flex flex-none gap-4 lg:gap-5">
            <button type="button" className={quiet} onClick={onDraw} disabled={busy || challenge.drawsLeft === 0}>New sequence</button>
            <button type="button" className={quiet} onClick={onCancel} disabled={busy}>Cancel</button>
          </span>
        </div>
      </div>
    </div>
  );
}

function Verified({ gamertag, verifiedAt }: { gamertag: string; verifiedAt: string }) {
  return (
    <div className={spread}>
      <div>
        <div className={step}>Linked</div>
        <h1 className={h1}>You are {gamertag}</h1>
        <p className={body}>Linked on {new Date(verifiedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}. Your clan, your base and your map hang off this.</p>
      </div>
      <div className={card}>
        <a className={button} href="/base">Your base <span className="font-mono normal-case">→</span></a>
        {/* M2: the real secondary button. Rewriting btnPrimary's classes left its gold hover under ink text (1.5:1) and a panel edge where a control's belongs. */}
        <a className={`mt-3 ${btnSecondary} w-full`} href="/me">Your page</a>
      </div>
    </div>
  );
}

function Refusal({ label: title, neutral = false, children }: { label: string; neutral?: boolean; children: React.ReactNode }) {
  // L1: a refusal owes the server nothing, so it is never rust (globals.css); the control edge makes it stand out instead.
  return (
    <div className={`mb-4 border px-3.5 py-3 ${neutral ? "border-rule-2 bg-surface" : "border-rule-3 bg-surface"}`} role={neutral ? "status" : "alert"}>
      <div className={label}>{title}</div>
      <div className="mt-1 text-sm leading-relaxed text-ink">{children}</div>
    </div>
  );
}
