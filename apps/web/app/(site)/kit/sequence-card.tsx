"use client";

import { useEffect, useState } from "react";
import { formatRemaining } from "@/lib/link-copy";
import { btnQuiet } from "@/app/components/ui";
import type { KitChallengeView } from "@/lib/kit-view";

/**
 * The open placement sequence.
 *
 * ⚠️ Deliberately the same card /link's "Prove it's you" uses, down to the
 * rust edge, the struck-through confirmed step and the olive: a player meets
 * that card once when they link and again here, and two different shapes for
 * "perform these emotes in this order" would read as two different mechanics.
 *
 * ⚠️ Rust, which in this palette means an obligation the player still owes
 * the server (globals.css). Never a generic error colour.
 */
export function SequenceCard({ challenge, busy, onDraw, onCancel }: {
  challenge: KitChallengeView; busy: boolean; onDraw: () => void; onCancel: () => void;
}) {
  // The countdown ticks by the second, like /link's. The sequence lasts
  // KIT_PLACEMENT_TTL_MS, so it reads as hours all day and as mm:ss at the end.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const remaining = new Date(challenge.expiresAt).getTime() - now;
  const total = challenge.steps.length;

  return (
    <section className="border-2 border-rust bg-frame">
      <div className="flex items-center justify-between gap-4 border-b-2 border-rust px-4 py-3 lg:px-5">
        <h2 className="m-0 font-display text-[13px] uppercase tracking-[0.06em] text-ink lg:text-sm">
          <span className="mr-3 text-rust-2">&bull;</span>Sequence open
        </h2>
        <span className="font-mono text-[11px] text-muted">
          <span className="hidden lg:inline">Expires in </span>{formatRemaining(remaining)}
        </span>
      </div>

      <p className="px-4 pt-4 text-sm leading-relaxed text-ink-2 lg:px-5">
        Stand exactly where you want the kit, open the emote wheel and perform these {total} emotes, in this order. Other emotes in between are fine. The order is what counts.
      </p>

      {/* ⚠️ An ordered list, because the order IS the proof. */}
      <ol className="flex flex-col gap-2 p-4 lg:gap-2.5 lg:p-5">
        {challenge.steps.map((s, i) => (
          <li key={s.token} className={`flex min-h-[56px] items-center gap-4 border-2 px-4 lg:min-h-[60px] ${s.confirmed ? "border-olive bg-surface" : "border-rule-2"}`}>
            <span className={`font-display text-xl lg:text-[22px] ${s.confirmed ? "text-olive" : "text-dim"}`}>{i + 1}</span>
            <span className={`font-display text-lg lg:text-xl ${s.confirmed ? "text-olive line-through" : "text-ink"}`}>{s.label}</span>
            <span className={`ml-auto font-mono text-[11px] uppercase tracking-[0.18em] ${s.confirmed ? "text-olive" : "text-muted"}`}>
              {s.confirmed ? "Confirmed" : "Waiting"}
            </span>
          </li>
        ))}
      </ol>

      {/* ⚠️ A SIBLING of the list, never an attribute on it: aria-live on the <ol> strips list semantics in several screen readers. */}
      <p role="status" aria-live="polite" className="sr-only">{challenge.confirmed} of {total} confirmed</p>

      <div className="mx-4 border border-rule-2 bg-surface px-3.5 py-3 text-sm leading-relaxed text-ink-2 lg:mx-5">
        <strong className="text-ink">The server has confirmed {challenge.confirmed} of {total}.</strong>{" "}
        Emotes reach us from the server log in batches, so a confirmation can take a little while to appear. This page checks every few seconds. Perform all {total} and you can log off, the spot catches up on its own.
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-rule-2 px-4 py-3.5 lg:flex-row lg:items-center lg:justify-between lg:gap-4 lg:px-5 lg:py-4">
        <span className="font-mono text-[11px] leading-relaxed text-muted">
          Can&rsquo;t find one of these on the wheel? Draw a new sequence.
        </span>
        <span className="flex flex-none gap-5">
          <button type="button" className={btnQuiet} onClick={onDraw} disabled={busy}>New sequence</button>
          <button type="button" className={btnQuiet} onClick={onCancel} disabled={busy}>Cancel</button>
        </span>
      </div>
    </section>
  );
}
