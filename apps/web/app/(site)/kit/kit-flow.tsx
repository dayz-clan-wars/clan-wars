"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Catalogue, CatalogueEntry, KitSlot } from "@factions/domain";
import { lookupCopy } from "@/lib/copy-lookup";
import { GROUND_RULES, KIT_GRID_ORDER, KIT_PIECES, RESULT_COPY, SLOT_LABELS, savedToast } from "@/lib/kit-copy";
import type { KitView } from "@/lib/kit-view";
import { DISCORD_INVITE } from "@/lib/site-meta";
import { Page, btnCta, kicker, link } from "@/app/components/ui";
import { PickSheet } from "./pick-sheet";
import { SequenceCard } from "./sequence-card";

/**
 * The booster kit page.
 *
 * ⚠️ A client component, like /link, and for the same reason: the page saves
 * as you pick and watches the server confirm emotes while you are standing in
 * a field. It needs JavaScript. The Save button and its no-JS form are gone
 * on purpose (design, 2026-09-19); what replaced them is a write per pick and
 * an Undo beside the confirmation.
 *
 * ⚠️ `view` is the ONLY source of truth for the nine picks, and every write
 * replaces it with the server's own re-read. Nothing here patches a slot
 * locally and hopes: a pick that was refused, or a spot a tick marked while
 * the page was open, would otherwise sit wrong on screen until a reload.
 */

const POLL_MS = 5_000;

export function KitFlow({ initial, catalogue }: { initial: KitView; catalogue: Catalogue | null }) {
  const [view, setView] = useState(initial);
  const [open, setOpen] = useState<KitSlot | null>(null);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<{ text: string; prev: { slot: KitSlot; value: string } } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const dismiss = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (dismiss.current) clearTimeout(dismiss.current); }, []);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/kit/status", { cache: "no-store" }).catch(() => null);
    if (!res) return;
    if (res.status === 401) { window.location.assign("/login?next=/kit"); return; }
    if (!res.ok) return;
    setView((await res.json()) as KitView);
  }, []);

  /**
   * ⚠️ Polls only while a sequence is open. Emotes reach the database in the
   * bot's tick batches, so a confirmation lands well behind the emote itself;
   * five seconds is often enough to feel live without a page nobody is
   * looking at hitting the database forever.
   */
  useEffect(() => {
    if (!view.challenge) return undefined;
    const id = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(id);
  }, [view.challenge?.id, refresh]);

  /**
   * Every write on this page.
   *
   * ⚠️ A refusal and an outage are told apart here and stay apart: the
   * server answers a refused pick with a `reason` the page looks up, and
   * anything else (a dead fetch, a 500, a body that is not JSON) becomes
   * `failed`, which says the pick did not save rather than blaming the pick.
   */
  const post = useCallback(async (path: string, body?: unknown): Promise<KitView | null> => {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).catch(() => null);
      if (!res) { setRefusal(RESULT_COPY.failed!); return null; }
      if (res.status === 401) { window.location.assign("/login?next=/kit"); return null; }
      const out = (await res.json().catch(() => null)) as { ok?: boolean; reason?: string; view?: KitView } | null;
      if (!out?.ok || !out.view) {
        setRefusal((typeof out?.reason === "string" ? lookupCopy(RESULT_COPY, out.reason) : undefined) ?? RESULT_COPY.failed!);
        return null;
      }
      setRefusal(null);
      setView(out.view);
      return out.view;
    } finally {
      setBusy(false);
    }
  }, []);

  const flash = useCallback((text: string, prev: { slot: KitSlot; value: string }) => {
    if (dismiss.current) clearTimeout(dismiss.current);
    setToast({ text, prev });
    dismiss.current = setTimeout(() => setToast(null), 4500);
  }, []);

  /** Save one slot. `label` is null for "Nothing", which clears it. */
  const choose = useCallback(async (slot: KitSlot, className: string, label: string | null) => {
    const prev = { slot, value: view.slots[slot] ?? "" };
    setOpen(null);
    const next = await post("/api/kit/slot", { slot, className });
    if (next) flash(savedToast(slot, label), prev);
  }, [post, flash, view.slots]);

  const undo = useCallback(async () => {
    const prev = toast?.prev;
    if (!prev) return;
    if (dismiss.current) clearTimeout(dismiss.current);
    setToast(null);
    await post("/api/kit/slot", { slot: prev.slot, className: prev.value });
  }, [toast, post]);

  const chosen = KIT_GRID_ORDER.filter((s) => view.slots[s]).length;

  return (
    <>
      {view.boosting && view.gamertag !== null && (
        <SpotStrip view={view} busy={busy} onDraw={() => { void post("/api/kit/draw"); }} />
      )}

      <Page>
        {refusal && (
          <div role="alert" className="mx-4 mt-4 border border-rust bg-surface px-3.5 py-3 text-sm leading-relaxed text-ink lg:mx-8">
            {refusal}
          </div>
        )}

        {!view.boosting && <NotBoosting />}
        {view.boosting && view.gamertag === null && <NotLinked />}

        {view.boosting && view.gamertag !== null && catalogue && (
          <div className="px-4 pb-28 pt-5 lg:px-8 lg:pb-16 lg:pt-7">
            {view.challenge && (
              <div className="mb-5">
                <SequenceCard
                  challenge={view.challenge}
                  busy={busy}
                  onDraw={() => { void post("/api/kit/draw"); }}
                  onCancel={() => { void post("/api/kit/cancel"); }}
                />
              </div>
            )}

            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <div className={kicker}>{view.gamertag}</div>
                <h1 className="mt-1.5 font-display text-[38px] uppercase leading-[.9] tracking-[-0.02em] text-ink lg:text-[56px]">Your kit</h1>
              </div>
              <div className="flex-none text-right">
                <div className="font-display text-[22px] leading-none text-gold">
                  {chosen}<span className="text-dim">/{KIT_PIECES}</span>
                </div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted" role="status">
                  {busy ? "Saving" : "All saved"}
                </div>
              </div>
            </div>

            <p className="mt-3.5 text-[13px] leading-relaxed text-ink-2">
              Tap any piece to change it. Changes save on their own.
            </p>

            <div className="lg:mt-5 lg:grid lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] lg:items-start lg:gap-5">
              <div className="mt-4 grid grid-cols-3 gap-2 lg:mt-0 lg:gap-3">
                {KIT_GRID_ORDER.map((slot) => (
                  <SlotTile key={slot} slot={slot} entry={entryFor(catalogue, slot, view.slots[slot])} onOpen={() => { setQuery(""); setOpen(slot); }} />
                ))}
              </div>
              <div className="mt-5 lg:mt-0">
                <HowThisWorks open={help} onToggle={() => setHelp((v) => !v)} />
              </div>
            </div>
          </div>
        )}
      </Page>

      {open && catalogue && (
        <PickSheet
          slot={open}
          options={catalogue[open]}
          current={view.slots[open]}
          query={query}
          onQuery={setQuery}
          onChoose={(className, label) => { void choose(open, className, label); }}
          onClose={() => setOpen(null)}
        />
      )}

      {toast && (
        <div className="cw-toast fixed inset-x-3 bottom-3 z-[1200] flex items-center justify-between gap-3 border border-rule-3 bg-surface py-3 pl-3.5 pr-2 shadow-[0_8px_24px_rgba(0,0,0,.6)] lg:left-auto lg:w-[420px] lg:right-8"
          style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}>
          <span className="min-w-0 text-sm leading-snug text-ink">{toast.text}</span>
          <button type="button" onClick={() => { void undo(); }} disabled={busy}
            className="min-h-[44px] flex-none px-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-gold disabled:opacity-40">
            Undo
          </button>
        </div>
      )}
    </>
  );
}

/** The catalogue entry a slot is currently set to, or null when it is empty. */
function entryFor(catalogue: Catalogue, slot: KitSlot, className: string | null): CatalogueEntry | null {
  if (!className) return null;
  return catalogue[slot].find((o) => o.className === className) ?? null;
}

/**
 * The bar under the site bar: where the kit lands, in one line, on every
 * state of this page.
 *
 * ⚠️ Sticky at `top-bar`, under the 52px site bar and below its z-index. It
 * is the one thing on the page a booster opens it to check, and the grid
 * below is nine tiles tall on a phone.
 */
function SpotStrip({ view, busy, onDraw }: { view: KitView; busy: boolean; onDraw: () => void }) {
  const waiting = view.challenge !== null;
  const marked = !waiting && view.spot !== null;
  const title = waiting ? "Waiting for your emotes" : view.spot ? `Kit live · Grid ${view.spot.grid}` : "No spot yet";
  const sub = waiting
    ? `Perform the emotes below where you want the kit. ${view.challenge!.confirmed} of ${view.challenge!.steps.length} confirmed.`
    : view.spot
      ? `Spawns here every restart.${view.spot.near ? ` Near ${view.spot.near}.` : ""}`
      : "Your kit has nowhere to spawn until you mark a spot in game.";
  return (
    <div className={`sticky top-bar z-20 flex items-center gap-3 border-b px-4 py-3 lg:px-8 ${waiting ? "border-rust bg-rust/10" : "border-rule-2 bg-frame"}`}>
      <span className={`h-2 w-2 flex-none rounded-full ${waiting ? "bg-rust-2" : marked ? "bg-gold" : "bg-dim"}`} />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink">{title}</div>
        <div className="mt-0.5 text-xs leading-snug text-ink-2">
          {sub}{" "}
          {marked && view.spot && <a className="text-gold underline-offset-4 hover:underline" href={view.spot.href}>Map &rarr;</a>}
        </div>
      </div>
      <button type="button" onClick={onDraw} disabled={busy}
        className="flex min-h-[44px] flex-none items-center pl-2 font-mono text-[11px] uppercase tracking-[0.14em] text-gold disabled:opacity-40">
        {waiting ? "Redraw" : marked ? "Move" : "Mark it"}
      </button>
    </div>
  );
}

/** One of the nine tiles. Filled tiles are framed; an empty one is dashed with a plus. */
function SlotTile({ slot, entry, onOpen }: { slot: KitSlot; entry: CatalogueEntry | null; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen}
      className={`flex min-h-[116px] cursor-pointer flex-col items-stretch p-2 text-left transition-colors hover:border-rule-3 lg:min-h-[170px] lg:p-3 ${entry ? "border border-rule-2 bg-frame" : "border border-dashed border-rule-2"}`}>
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">{SLOT_LABELS[slot]}</span>
      {entry?.image
        ? <img src={`/${entry.image}`} alt="" className="my-1.5 h-[62px] w-full object-contain lg:h-24" />
        : entry
          // ⚠️ Coverage gaps are expected and must look deliberate, not broken:
          // a catalogue entry may have no picture yet, and the tile still has
          // to read as a piece you are wearing.
          ? <span className="my-1.5 flex h-[62px] items-center justify-center border border-dashed border-rule-2 text-[10px] uppercase tracking-wide text-dim lg:h-24">No art</span>
          : <span className="my-1.5 flex h-[62px] items-center justify-center text-xl text-rule-3 lg:h-24 lg:text-[26px]" aria-hidden="true">+</span>}
      <span className={`mt-auto block text-[11px] leading-tight lg:text-[13px] ${entry ? "text-ink" : "text-dim"}`}>
        {entry ? entry.label : "Empty"}
      </span>
    </button>
  );
}

/** The three sentences the page owes the player, plus what the perk is. */
function HowThisWorks({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <section className="border border-rule-2 bg-frame">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex min-h-[48px] w-full items-center justify-between gap-3 px-3.5 text-left font-display text-xs uppercase tracking-[0.06em] text-ink">
        How this works
        <span aria-hidden="true" className={`text-xs text-muted transition-transform ${open ? "rotate-180" : ""}`}>&#9662;</span>
      </button>
      {open && (
        <div className="border-t border-rule-2 p-3.5">
          <p className="text-[13px] leading-relaxed text-ink-2">
            Boost the Discord and you get a kit. You pick nine pieces of clothing here, then mark a spot in game with a short emote sequence. The kit spawns there every restart for as long as you keep boosting.
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-[13px] leading-relaxed text-ink-2">
            {GROUND_RULES.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
            Pick your spot with that in mind. Somewhere quiet gets you your clothes back. Somewhere obvious hands them to whoever gets there first, which is a fine thing to do on purpose.
          </p>
          <p className="mt-3 text-[11px] leading-relaxed text-dim">
            Item pictures come from the <a className={link} href="https://dayz.wiki.gg">DayZ wiki</a> and <a className={link} href="https://dayz.fandom.com">DayZ Fandom wiki</a>, used under CC BY-SA until we make our own.
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * ⚠️ The page a visitor who is not boosting gets, in full, rather than a
 * refusal. Someone deciding whether to boost has to be able to see what they
 * would get, and this is the only page that sells it.
 */
function NotBoosting() {
  const [help, setHelp] = useState(false);
  return (
    <div className="px-4 pb-16 pt-6 lg:px-8">
      <div className={kicker}>Booster kit</div>
      <h1 className="mt-1.5 font-display text-[38px] uppercase leading-[.9] tracking-[-0.02em] text-ink lg:text-[56px]">
        Nine pieces,<br />your spot
      </h1>
      <p className="mt-3.5 max-w-[34rem] text-sm leading-relaxed text-ink-2">
        Boost the Discord and you get a kit: nine pieces of clothing you pick, dropped where you marked them, every restart.
      </p>
      <div className="mt-5 grid max-w-[34rem] grid-cols-3 gap-2 opacity-45">
        {["MilitaryCap_Woodland", "GorkaEJacket_Summer", "AliceBag_Green"].map((c) => (
          <img key={c} src={`/items/${c}.webp`} alt="" className="h-16 w-full border border-rule-2 bg-frame object-contain p-1.5" />
        ))}
      </div>
      <a className={`mt-5 max-w-[34rem] ${btnCta}`} href={DISCORD_INVITE}>
        Boost on Discord <span className="font-mono normal-case">&rarr;</span>
      </a>
      <p className="mt-3.5 max-w-[34rem] text-sm leading-relaxed text-ink-2">
        Open the Discord server, tap the server name at the top, and choose Boosts. Discord charges you, not us. Boosts also raise the whole server, so everyone gets the upload limits and the audio quality.
      </p>
      <p className="mt-3 max-w-[34rem] text-sm leading-relaxed text-ink-2">
        We check Discord for new boosts on a timer, so your kit turns on at the next check rather than the instant you boost, and the pickers appear on this page then. Stop boosting and the kit stops spawning at the next restart. Your nine picks are kept, so it comes straight back if you boost again.
      </p>
      <div className="mt-6 max-w-[34rem]"><HowThisWorks open={help} onToggle={() => setHelp((v) => !v)} /></div>
    </div>
  );
}

/** Boosting, but with no character to perform the sequence as. */
function NotLinked() {
  const [help, setHelp] = useState(false);
  return (
    <div className="px-4 pb-16 pt-6 lg:px-8">
      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-gold">Boost active</div>
      <h1 className="mt-1.5 font-display text-[38px] uppercase leading-[.9] tracking-[-0.02em] text-ink lg:text-[56px]">
        One step<br />to go
      </h1>
      <p className="mt-3.5 max-w-[34rem] text-sm leading-relaxed text-ink-2">
        Your boost is on. The spot is marked in game, so we need to know which character is yours first.
      </p>
      <a className={`mt-5 max-w-[34rem] ${btnCta}`} href="/link">
        Link your character <span className="font-mono normal-case">&rarr;</span>
      </a>
      <p className="mt-3.5 max-w-[34rem] text-sm leading-relaxed text-dim">Come back here afterwards and your nine pickers appear.</p>
      <div className="mt-6 max-w-[34rem]"><HowThisWorks open={help} onToggle={() => setHelp((v) => !v)} /></div>
    </div>
  );
}
