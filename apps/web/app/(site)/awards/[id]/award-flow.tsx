"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AwardDef, AwardItem } from "@factions/domain";
import { lookupCopy } from "@/lib/copy-lookup";
import { GROUND_RULES, RESULT_COPY, STATE_COPY } from "@/lib/award-copy";
import type { AwardPageView } from "@/lib/award-view";
import { Page, btnCta, btnPrimary, kicker } from "@/app/components/ui";
import { PickSheet } from "../../kit/pick-sheet";
import { SequenceCard } from "../../kit/sequence-card";

const POLL_MS = 5_000;
const OPEN = new Set(["unplaced", "waiting", "live"]);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * One award's page.
 *
 * ⚠️ `view` is the only source of truth, and every write replaces it with the
 * server's own re-read — kit-flow.tsx's rule, for its reason: a refused pick,
 * or a spot the tick marked while the page was open, must not sit wrong on
 * screen. The newest-write-wins ticket is kept for the same race.
 */
export function AwardFlow({ initial, def }: { initial: AwardPageView; def: AwardDef }) {
  const [view, setView] = useState(initial);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const writes = useRef({ started: 0, inFlight: 0 });
  const base = `/api/awards/${view.id}`;

  const refresh = useCallback(async () => {
    const at = writes.current.started;
    if (writes.current.inFlight > 0) return;
    const res = await fetch(`${base}/status`, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const next = (await res.json().catch(() => null)) as AwardPageView | null;
    if (!next || writes.current.started !== at || writes.current.inFlight > 0) return;
    setView(next);
  }, [base]);

  useEffect(() => {
    if (!view.challenge) return undefined;
    const id = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(id);
  }, [view.challenge?.id, refresh]);

  const post = useCallback(async (path: string, body?: unknown) => {
    const mine = ++writes.current.started;
    writes.current.inFlight += 1;
    setBusy(true);
    try {
      const res = await fetch(`${base}/${path}`, {
        method: "POST",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).catch(() => null);
      if (res?.status === 401) { window.location.assign(`/login?next=/awards/${view.id}`); return; }
      const out = (await res?.json().catch(() => null)) as { ok?: boolean; reason?: string; view?: AwardPageView } | null;
      if (mine !== writes.current.started) return;
      if (!out?.ok || !out.view) {
        setRefusal((typeof out?.reason === "string" ? lookupCopy(RESULT_COPY, out.reason) : undefined) ?? RESULT_COPY.failed!);
        return;
      }
      setRefusal(null);
      setView(out.view);
    } finally {
      writes.current.inFlight -= 1;
      if (writes.current.inFlight === 0) setBusy(false);
    }
  }, [base, view.id]);

  const isOpen = OPEN.has(view.state);
  const slots = Object.entries(def.slots);
  const entry = (slot: string): AwardItem | null =>
    def.slots[slot]!.items.find((i) => i.className === view.picks[slot]) ?? null;
  const complete = slots.every(([s]) => entry(s) !== null);
  const state = STATE_COPY[view.state];

  return (
    <>
      <Page>
        <div className="px-4 pb-28 pt-5 lg:px-8 lg:pb-16 lg:pt-7">
          <div className={kicker}>Event award</div>
          <h1 className="mt-1.5 font-display text-[38px] uppercase leading-[.9] tracking-[-0.02em] text-ink lg:text-[56px]">{view.label}</h1>
          <p className="mt-2 text-sm text-ink-2">{view.reason}</p>

          <div className="mt-4 border border-rule-2 bg-frame p-3.5">
            <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink">{state.title}</div>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
              {state.line}{" "}
              {view.state === "unplaced" && <>Place it by {when(view.placeBy)}.</>}
              {view.state === "waiting" && <>Next restart: {when(view.nextRestartAt)}.</>}
              {view.state === "live" && view.expiresAt && <>Live until {when(view.expiresAt)}.</>}
            </p>
            {view.spot && (
              <p className="mt-1 text-[13px] text-ink-2">
                Grid {view.spot.grid}{view.spot.near ? `, near ${view.spot.near}` : ""}.{" "}
                <a className="text-gold underline-offset-4 hover:underline" href={view.spot.href}>Map &rarr;</a>
              </p>
            )}
          </div>

          {isOpen && view.gamertag === null && (
            <a className={`mt-5 max-w-[34rem] ${btnCta}`} href="/link">
              Link your character <span className="font-mono normal-case">&rarr;</span>
            </a>
          )}

          {isOpen && view.challenge && (
            <div className="mt-5">
              <SequenceCard challenge={view.challenge} busy={busy}
                onDraw={() => { void post("place"); }} onCancel={() => { void post("cancel"); }} />
            </div>
          )}

          <div className="mt-5 grid grid-cols-3 gap-2 lg:gap-3">
            {slots.map(([slot, s]) => {
              const e = entry(slot);
              return (
                <button key={slot} type="button" disabled={!isOpen}
                  onClick={() => { setQuery(""); setOpen(slot); }}
                  className={`flex min-h-[116px] flex-col items-stretch p-2 text-left lg:min-h-[170px] lg:p-3 ${e ? "border border-rule-2 bg-frame" : "border border-dashed border-rule-2"} disabled:cursor-default`}>
                  <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">{s.label}</span>
                  {e?.image
                    ? <img src={`/${e.image}`} alt="" className="my-1.5 h-[62px] w-full object-contain lg:h-24" />
                    : <span className="my-1.5 flex h-[62px] items-center justify-center text-xl text-rule-3 lg:h-24" aria-hidden="true">+</span>}
                  <span className={`mt-auto block text-[11px] leading-tight lg:text-[13px] ${e ? "text-ink" : "text-dim"}`}>{e ? e.label : "Pick one"}</span>
                </button>
              );
            })}
          </div>

          {isOpen && view.gamertag !== null && !view.challenge && (
            // ⚠️ Disabled, not hidden, until every piece is picked: the button
            // is what tells the winner there is a step after picking.
            <button type="button" className={`mt-5 ${btnPrimary}`} disabled={!complete || busy}
              onClick={() => { void post("place"); }}>
              {view.spot ? "Move it in game" : "Place in game"}
            </button>
          )}

          <ul className="mt-6 flex max-w-[34rem] flex-col gap-2 text-[13px] leading-relaxed text-ink-2">
            {GROUND_RULES.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      </Page>

      {open && (
        <PickSheet
          label={def.slots[open]!.label}
          options={def.slots[open]!.items}
          current={view.picks[open] ?? null}
          query={query}
          onQuery={setQuery}
          busy={busy}
          allowEmpty={false}
          onChoose={(className) => { setOpen(null); void post("pick", { slot: open, className }); }}
          onClose={() => setOpen(null)}
        />
      )}

      {refusal !== null && (
        <div role="alert" className="cw-toast fixed inset-x-3 bottom-3 z-[1200] flex items-center justify-between gap-3 border border-rust bg-surface py-3 pl-3.5 pr-2 lg:left-auto lg:right-8 lg:w-[420px]">
          <span className="min-w-0 text-sm leading-snug text-ink">{refusal}</span>
          <button type="button" onClick={() => setRefusal(null)} className="min-h-[44px] flex-none px-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Dismiss</button>
        </div>
      )}
    </>
  );
}
