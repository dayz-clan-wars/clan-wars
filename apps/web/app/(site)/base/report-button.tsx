"use client";

import { useEffect, useId, useRef, useState } from "react";
import { btnDanger, btnQuiet, checkbox } from "@/app/components/ui";
import { reportFocusAfter, type ReportPhase } from "@/lib/report-focus";

const ARM_MS = 8_000;

export type ReportParticipant = { dayzId: string; gamertag: string };

/**
 * Presses charges on a CHOSEN SUBSET of one witnessed incident's
 * participants. ⚠️ Deliberately free of any roster-package import — `next
 * build` is the only thing that catches a client component pulling that
 * package's pooled postgres client into the browser bundle ("Can't resolve
 * 'fs'"), which no typecheck or vitest run catches (broke a deploy on
 * 2026-09-13). Everything this component needs is a prop.
 *
 * This is a real safety control, not decoration: a bare click on
 * `reportIncident` bans every CHECKED player with no staff adjudicator in
 * the loop. The first press only arms the button and states, in words,
 * exactly who gets banned and for how long at minimum; nothing is sent to
 * the server until the second press, within `ARM_MS`. Per-participant
 * checkboxes exist so an owner can charge a raider without also banning a
 * helper they invited — both would otherwise be sentenced jointly on the
 * whole incident's damage (spec §2.4, §7).
 *
 * ⚠️ H4 (UX review 2026-09-24): focus is moved on every branch change
 * (lib/report-focus.ts), and the outcome is spoken by ONE live region that is
 * mounted from the first render. A region inserted together with its text is
 * announced unreliably, and this outcome is a ban.
 */
export function ReportButton({ incidentId, participants, minTermLabel }: { incidentId: number; participants: ReportParticipant[]; minTermLabel: string }) {
  // ⚠️ Defaults to everyone selected — the common case (a raid with no
  // invited helper) should not require checking every box, and the confirm
  // step still names exactly who before anything is sent.
  const [checked, setChecked] = useState<Set<string>>(() => new Set(participants.map((p) => p.dayzId)));
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const warningId = useId();
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const phase: ReportPhase = done ? "done" : armed ? "armed" : "idle";
  const shown = useRef<ReportPhase>(phase);
  useEffect(() => {
    const target = reportFocusAfter(shown.current, phase);
    shown.current = phase;
    if (target === "confirm") confirmRef.current?.focus();
    else if (target === "press") pressRef.current?.focus();
    else if (target === "status") statusRef.current?.focus();
  }, [phase]);

  const stopTimer = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const disarm = () => { stopTimer(); setArmed(false); };
  const arm = () => {
    setError(null);
    setArmed(true);
    stopTimer();
    timer.current = setTimeout(() => setArmed(false), ARM_MS);
  };

  const toggle = (dayzId: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(dayzId)) next.delete(dayzId); else next.add(dayzId);
      return next;
    });
  };

  const submit = async () => {
    if (busy) return;
    // ⚠️ The countdown stops but the armed block STAYS while the request runs:
    // dropping it here unmounted the focused Confirm mid-request and hid "Pressing charges…".
    stopTimer();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/base/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ incidentId, chargedDayzIds: [...checked] }),
      });
      if (res.status === 401) { window.location.reload(); return; }
      const data = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!data?.ok) { setError(data?.message ?? "Could not press charges on that incident."); setArmed(false); return; }
      setDone(true);
    } catch {
      setError("Could not press charges on that incident.");
      setArmed(false);
    } finally {
      setBusy(false);
    }
  };

  const chargedNames = participants.filter((p) => checked.has(p.dayzId)).map((p) => p.gamertag).join(", ");

  const body = (() => {
    if (done) return null;
    if (armed) {
      return (
        <div className="flex flex-col gap-3">
          <p id={warningId} className="text-sm leading-relaxed text-ink-2">
            This automatically bans <span className="text-ink">{chargedNames || "nobody — pick at least one player"}</span> for at least <span className="text-ink">{minTermLabel}</span> each — doubled on a repeat offence, and <span className="text-ink">permanent</span> on a third upheld report this season. Prior offences are checked when you confirm, so a permanent ban can happen on THIS click without further warning. There is no further review after you confirm.
          </p>
          <div className="flex flex-wrap gap-3">
            {/* ⚠️ aria-disabled while busy, not disabled: a disabled button drops focus to <body>. */}
            <button ref={confirmRef} type="button" className={`${btnDanger} aria-disabled:opacity-40`} aria-describedby={warningId}
              aria-disabled={busy || undefined} disabled={checked.size === 0} onClick={() => void submit()}>
              {busy ? "Pressing charges…" : "Confirm — press charges"}
            </button>
            <button type="button" className={`${btnQuiet} aria-disabled:opacity-40`} aria-disabled={busy || undefined} onClick={() => { if (!busy) disarm(); }}>Cancel</button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        {participants.length > 1 && (
          <fieldset className="flex flex-col">
            <legend className="text-xs uppercase tracking-[0.14em] text-muted">Charge</legend>
            {participants.map((p) => (
              <label key={p.dayzId} className="flex min-h-[44px] items-center gap-3 text-sm text-ink-2">
                <input type="checkbox" className={checkbox} checked={checked.has(p.dayzId)} onChange={() => toggle(p.dayzId)} />
                {p.gamertag}
              </label>
            ))}
          </fieldset>
        )}
        <button ref={pressRef} type="button" className={btnDanger} disabled={checked.size === 0} onClick={arm}>
          Press charges
        </button>
      </div>
    );
  })();

  return (
    <div className="flex flex-col gap-2">
      {body}
      {/* ⚠️ One live region, mounted on every branch from the first render (H4). L1: a failure is plain ink on the control edge, never rust. */}
      <p ref={statusRef} role="status" tabIndex={-1} className="text-sm focus:outline-none">
        {done
          ? <span className="text-ink-2">Charges pressed. The listed players are banned.</span>
          : error && <span className="block border border-rule-3 bg-surface px-3 py-2 text-ink">{error}</span>}
      </p>
    </div>
  );
}
