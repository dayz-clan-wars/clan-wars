"use client";

import { useEffect, useId, useRef, useState } from "react";
import { guardFormSubmit } from "@/lib/submit-guard";
import { confirmBlur, confirmExpire, confirmPress, type ConfirmPhase } from "@/lib/confirm-press";

export const ARM_MS = 4_000;

/**
 * The armed look (M4): the same button inverted to gold, so "press again" is
 * visible and not just a relabel. ⚠️ Gold, never rust — rust means an
 * obligation the player owes the server (globals.css), not "careful".
 */
export const ARMED_CLASS = "!border-2 !border-gold !bg-ground !text-gold";

/**
 * A submit button for the one-click removals — kick, demote, withdraw an
 * invite, revoke a pass — that need a confirmation but not a checkbox: the
 * first press arms it and swaps the label for `confirm` ("Press again to
 * remove"), the second press within four seconds submits the form it sits in.
 * Nothing happens if the player looks away; it disarms itself.
 *
 * No dialog: a `confirm()` blocks the page and reads badly on a phone, and
 * the site's forms otherwise never need script to submit.
 *
 * ⚠️ H1: once the form has posted, further presses do nothing. Before this a
 * third tap posted again: `armed` stayed true and every tap after the first
 * submitted. The form guard (lib/submit-guard.ts) refuses a second `submit`
 * even when this component's state has not caught up.
 */
/**
 * Fix round 1 (Task 13 review): pulled out of the JSX so the armed branch —
 * unreachable from SSR, which only ever renders `idle` — can be unit-tested
 * directly instead of only through the idle path.
 */
export function confirmButtonContent(phase: ConfirmPhase, children: React.ReactNode, confirm: React.ReactNode, pendingLabel?: React.ReactNode): React.ReactNode {
  return phase === "armed" ? confirm : phase === "pending" && pendingLabel !== undefined ? pendingLabel : children;
}

export function ConfirmButton({ confirm, className, children, disabled = false, pending: pendingLabel }: {
  // ⚠️ Fix round 1: widened from `string` — RowAction needs to append the
  // sr-only `who` span to the armed label too, not just the idle one, or a
  // screen reader hears "Press again to remove" with no name while armed.
  confirm: React.ReactNode; className: string; children: React.ReactNode; disabled?: boolean; pending?: React.ReactNode;
}) {
  const [phase, setPhase] = useState<ConfirmPhase>("idle");
  const ref = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hint = useId();
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => () => clear(), []);
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return undefined;
    return guardFormSubmit(form, window, (p) => { clear(); setPhase(p ? "pending" : "idle"); });
  }, []);

  return (
    <>
      {/* ⚠️ `aria-disabled:opacity-40`, the same idiom `report-button.tsx` and
          `link-flow.tsx` use for the same pending look — unlike SubmitButton
          (components/submit-button.tsx), this file's SSR test never does a
          blunt substring check for the word "disabled" across the whole
          markup, so the variant is safe here. The guard (submit-guard.ts) is
          what actually stops the second POST; the attribute and class only
          say so. */}
      <button ref={ref} type="submit" className={`${className} ${phase === "armed" ? ARMED_CLASS : ""} aria-disabled:opacity-40`}
        aria-live="polite" disabled={disabled}
        aria-describedby={phase === "armed" ? hint : undefined}
        aria-disabled={phase === "pending" || undefined} aria-busy={phase === "pending" || undefined}
        onClick={(e) => {
          const { next, submit } = confirmPress(phase);
          if (!submit) e.preventDefault();
          else clear();
          setPhase(next);
          if (phase === "idle") timer.current = setTimeout(() => setPhase(confirmExpire), ARM_MS);
        }}
        onBlur={() => { clear(); setPhase(confirmBlur); }}>
        {confirmButtonContent(phase, children, confirm, pendingLabel)}
      </button>
      {/* M4: the second press, explained to a screen reader while it is armed. Visually the gold look and the "Press again to …" label say it. */}
      {phase === "armed" && <span id={hint} className="sr-only">{`Press again within ${ARM_MS / 1000} seconds to confirm. Wait, or move away, and it cancels itself.`}</span>}
    </>
  );
}
