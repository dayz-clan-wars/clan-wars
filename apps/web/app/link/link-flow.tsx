"use client";

import { useEffect, useRef, useState } from "react";
import { LINK_EMOTES } from "@factions/domain";
import type { IssueOutcome, LinkStatus } from "@factions/roster";
import { ENDED_COPY, ISSUE_COPY, formatRemaining } from "@/lib/link-copy";

/** `LinkStatus` after a trip through JSON: every Date is an ISO string. */
type Wire<T> = T extends Date ? string : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;
type Status = Wire<LinkStatus>;
type Outcome = Wire<IssueOutcome>;

const POLL_MS = 5_000;

const card = "w-full max-w-[390px] rounded-lg border border-rule bg-frame p-6";
const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";
const button = "flex min-h-[52px] w-full items-center justify-center rounded-md bg-gold px-4 font-display text-base text-ground disabled:opacity-40";
const quiet = "font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline disabled:opacity-40";

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
    <div className={card}>
      <div className={label}>Step 2 of 3 — name your character</div>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink">Which one is you?</h1>
      <p className="mt-3 text-base leading-relaxed text-ink-2">The gamertag you play under. Only characters the server has actually seen are listed — if yours is missing, play a session first.</p>
      {(notice || denial) && <Refusal label="Not issued">{denial ?? notice}</Refusal>}
      <input className="mt-4 min-h-[52px] w-full rounded-md border border-rule-2 bg-surface px-4 font-mono text-ink" value={query}
        onChange={(e) => { setQuery(e.target.value); setDenial(null); }} placeholder="Gamertag" aria-label="Gamertag" autoComplete="off" spellCheck={false} />
      <div className="mt-2 flex flex-col gap-1" role="listbox" aria-label="Characters the server has seen">
        {query.trim() && matches.length === 0 && <div className="px-2 py-2 font-mono text-xs text-muted">No unclaimed character by that name</div>}
        {matches.map((m) => (
          <button key={m.dayzId} type="button" role="option" aria-selected={m.gamertag.toLowerCase() === query.trim().toLowerCase()}
            className="min-h-[44px] rounded-md px-3 text-left font-mono text-ink hover:bg-surface" onClick={() => setQuery(m.gamertag)}>
            {m.gamertag}
          </button>
        ))}
      </div>
      <button className={`mt-6 ${button}`} type="button" onClick={claim} disabled={busy || !query.trim()}>Claim it</button>
      <div className="mt-4 font-mono text-xs leading-relaxed text-muted">One character per Discord account. You will prove it is you with {LINK_EMOTES} emotes in game.</div>
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

  return (
    <div className={`${card} border-rust`}>
      <div className={label}>Step 3 of 3 — one step left</div>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink">Prove it&rsquo;s you</h1>
      <div className="mt-2 font-mono text-lg text-gold">{challenge.gamertag}</div>
      {notice && <Refusal label="Switched" neutral>{notice}</Refusal>}
      <p className="mt-3 text-base leading-relaxed text-ink-2">In game as that character, open the emote wheel and perform these {total}, in this order. Other emotes in between are fine — the order is what counts.</p>
      {/* ⚠️ An ordered list, because the order IS the proof. */}
      <ol className="mt-4 flex flex-col gap-2">
        {challenge.steps.map((step, i) => (
          <li key={step.token} className={`flex min-h-[56px] items-center gap-3 rounded-md border px-4 ${step.confirmed ? "border-olive bg-surface" : "border-rule-2"}`}>
            <span className={`font-mono text-xs ${step.confirmed ? "text-olive" : "text-muted"}`}>{i + 1}</span>
            <span className={`font-display text-lg ${step.confirmed ? "text-olive line-through" : "text-ink"}`}>{step.label}</span>
            {step.confirmed && <span className="ml-auto font-mono text-xs uppercase tracking-[0.18em] text-olive">Confirmed</span>}
          </li>
        ))}
      </ol>
      {/* ⚠️ A SIBLING of the list, never an attribute on it: aria-live on the <ol> strips list semantics in several screen readers. */}
      <p role="status" aria-live="polite" className="sr-only">{challenge.confirmed} of {total} confirmed</p>
      <div className="mt-4 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink-2">
        <strong className="text-ink">The server has confirmed {challenge.confirmed} of {total}.</strong>{" "}
        Emotes reach us from the server log in batches, so a confirmation can take up to a minute to appear. This page checks every few seconds; perform all {LINK_EMOTES} and you can log off — the link catches up on its own.
      </div>
      <div className="mt-4 flex items-center justify-between">
        <div className="font-mono text-xs text-muted">Expires in {formatRemaining(remaining)}</div>
        <div className="flex gap-4">
          <button type="button" className={quiet} onClick={onDraw} disabled={busy || challenge.drawsLeft === 0}>New sequence</button>
          <button type="button" className={quiet} onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </div>
      <div className="mt-3 font-mono text-xs text-muted">
        {challenge.drawsLeft > 0
          ? `Can’t find one of these on the wheel? Draw a new sequence — ${challenge.drawsLeft} ${challenge.drawsLeft === 1 ? "draw" : "draws"} left today.`
          : "Out of draws for this character today. If an emote is missing from your wheel, say so in the Discord rather than working around it."}
      </div>
    </div>
  );
}

function Verified({ gamertag, verifiedAt }: { gamertag: string; verifiedAt: string }) {
  return (
    <div className={card}>
      <div className={label}>Linked</div>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink">You are {gamertag}</h1>
      <p className="mt-3 text-base leading-relaxed text-ink-2">Linked on {new Date(verifiedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}. Your clan, your base and your map hang off this.</p>
      <a className={`mt-6 ${button}`} href="/base">Your base</a>
      <a className={`mt-3 ${quiet} block text-center`} href="/me">Your page</a>
    </div>
  );
}

function Refusal({ label: title, neutral = false, children }: { label: string; neutral?: boolean; children: React.ReactNode }) {
  return (
    <div className={`mt-4 rounded-md border p-3 ${neutral ? "border-rule-2 bg-surface" : "border-rust bg-surface"}`} role={neutral ? "status" : "alert"}>
      <div className={label}>{title}</div>
      <div className="mt-1 text-sm text-ink">{children}</div>
    </div>
  );
}
