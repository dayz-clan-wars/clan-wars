"use client";

import { useEffect, useRef, useState } from "react";
import { LINK_EMOTES } from "@factions/domain";
import type { IssueOutcome, LinkStatus } from "@factions/roster";
import { ENDED_COPY, ISSUE_COPY, formatRemaining } from "@/lib/link-copy";
import { btnCta, btnPrimary, btnQuiet, field } from "@/app/components/ui";

/** `LinkStatus` after a trip through JSON: every Date is an ISO string. */
type Wire<T> = T extends Date ? string : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;
type Status = Wire<LinkStatus>;
type Outcome = Wire<IssueOutcome>;

const POLL_MS = 5_000;

const spread = "grid gap-6 px-5 py-6 lg:grid-cols-2 lg:gap-16 lg:px-8 lg:py-14";
const step = "font-mono text-[10px] uppercase tracking-[0.18em] text-muted lg:text-[11px]";
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

  const refresh = async () => {
    const res = await fetch("/api/link/status", { cache: "no-store" });
    if (res.status === 401) { window.location.assign("/login?next=/link"); return; }
    if (!res.ok) return;
    const next: Status = await res.json();
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
    if (!status.challenge) return;
    const id = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(id);
  }, [status.challenge?.id]);

  const start = async (dayzId: string, newSequence = false) => {
    setBusy(true);
    try {
      const res = await fetch("/api/link/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dayzId, newSequence }) });
      if (res.status === 401) { window.location.assign("/login?next=/link"); return; }
      const { outcome } = (await res.json()) as { outcome: Outcome };
      if (outcome.kind === "issued" || outcome.kind === "live") {
        setNotice(outcome.kind === "issued" && outcome.switchedFrom
          ? `Canceled your challenge for ${outcome.switchedFrom} — that sequence no longer works. Here is the new one.`
          : null);
        await refresh();
      } else {
        setNotice(ISSUE_COPY[outcome.kind](outcome as unknown as IssueOutcome));
      }
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await fetch("/api/link/cancel", { method: "POST" });
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
  const [matches, setMatches] = useState<{ dayzId: string; gamertag: string }[]>([]);
  const [denial, setDenial] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (!q) { setMatches([]); return; }
    timer.current = setTimeout(async () => {
      const res = await fetch(`/api/link/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      if (res.ok) setMatches((await res.json()).matches);
    }, 200);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query]);

  /**
   * ⚠️ Resolved from the typed text on submit, not from whatever row was last
   * clicked — autocomplete is a suggestion, and the package re-validates the
   * UID anyway. A full gamertag typed without touching the list still works.
   */
  const claim = () => {
    const typed = query.trim().toLowerCase();
    const found = matches.find((m) => m.gamertag.toLowerCase() === typed);
    if (!found) { setDenial("The server has not seen that character. Pick one from the list — only characters the event log has seen can be linked."); return; }
    setDenial(null);
    onClaim(found.dayzId);
  };

  return (
    <div className={spread}>
      <div>
        <div className={step}>Step 2 of 3 — name your character</div>
        <h1 className={h1}>Which one is you?</h1>
        <p className={body}>The gamertag you play under. Only characters the server has actually seen are listed — if yours is missing, play a session first.</p>
        <p className="mt-4 hidden font-mono text-[11px] leading-relaxed text-muted lg:block">One character per Discord account. You will prove it is you with {LINK_EMOTES} emotes in game.</p>
      </div>
      <div className={card}>
        {(notice || denial) && <Refusal label="Not issued">{denial ?? notice}</Refusal>}
        <input className={field.replace("mt-1", "")} value={query}
          onChange={(e) => { setQuery(e.target.value); setDenial(null); }} placeholder="Gamertag" aria-label="Gamertag" autoComplete="off" spellCheck={false} />
        <div className="mt-2 flex flex-col gap-1" role="listbox" aria-label="Characters the server has seen">
          {query.trim() && matches.length === 0 && <div className="px-2 py-2 font-mono text-xs text-muted">No unclaimed character by that name</div>}
          {matches.map((m) => (
            <button key={m.dayzId} type="button" role="option" aria-selected={m.gamertag.toLowerCase() === query.trim().toLowerCase()}
              className="min-h-[44px] px-3 text-left font-mono text-ink hover:bg-surface" onClick={() => setQuery(m.gamertag)}>
              {m.gamertag}
            </button>
          ))}
        </div>
        <button className={`mt-5 ${button}`} type="button" onClick={claim} disabled={busy || !query.trim()}>Claim it <span className="font-mono normal-case">→</span></button>
        <div className="mt-4 font-mono text-[11px] leading-relaxed text-muted lg:hidden">One character per Discord account. You will prove it is you with {LINK_EMOTES} emotes in game.</div>
      </div>
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
        <div className={step}>Step 3 of 3 — one step left</div>
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
          <h2 className="m-0 font-display text-[13px] uppercase tracking-[0.06em] text-ink lg:text-sm"><span className="mr-3 text-rust">●</span>Challenge open</h2>
          <span className="font-mono text-[11px] text-muted"><span className="hidden lg:inline">Expires in </span>{formatRemaining(remaining)}</span>
        </div>
        {notice && <div className="px-4 pt-4 lg:px-5"><Refusal label="Switched" neutral>{notice}</Refusal></div>}
        {/* ⚠️ An ordered list, because the order IS the proof. */}
        <ol className="flex flex-col gap-2 p-4 lg:gap-2.5 lg:p-5">
          {challenge.steps.map((s, i) => (
            <li key={s.token} className={`flex min-h-[56px] items-center gap-4 border-2 px-4 lg:min-h-[60px] ${s.confirmed ? "border-olive bg-surface" : "border-rule-2"}`}>
              <span className={`font-display text-xl lg:text-[22px] ${s.confirmed ? "text-olive" : "text-dim"}`}>{i + 1}</span>
              <span className={`font-display text-lg lg:text-xl ${s.confirmed ? "text-olive line-through" : "text-ink"}`}>{s.label}</span>
              <span className={`ml-auto font-mono text-[10px] uppercase tracking-[0.18em] ${s.confirmed ? "text-olive" : "text-muted"}`}>{s.confirmed ? "Confirmed" : "Waiting"}</span>
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
        <a className={`mt-3 ${btnPrimary.replace("bg-gold", "border-2 border-rule-2 bg-transparent").replace("text-ground", "text-ink")} w-full`} href="/me">Your page</a>
      </div>
    </div>
  );
}

function Refusal({ label: title, neutral = false, children }: { label: string; neutral?: boolean; children: React.ReactNode }) {
  return (
    <div className={`mb-4 border px-3.5 py-3 ${neutral ? "border-rule-2 bg-surface" : "border-rust bg-surface"}`} role={neutral ? "status" : "alert"}>
      <div className={label}>{title}</div>
      <div className="mt-1 text-sm leading-relaxed text-ink">{children}</div>
    </div>
  );
}
