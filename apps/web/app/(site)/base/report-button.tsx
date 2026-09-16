"use client";

import { useEffect, useRef, useState } from "react";
import { btnDanger, btnQuiet } from "@/app/components/ui";

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
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    setArmed(false);
  };

  const toggle = (dayzId: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(dayzId)) next.delete(dayzId); else next.add(dayzId);
      return next;
    });
  };

  const submit = async () => {
    disarm();
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
      if (!data?.ok) { setError(data?.message ?? "Could not press charges on that incident."); return; }
      setDone(true);
    } catch {
      setError("Could not press charges on that incident.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return <p role="status" className="text-sm text-ink-2">Charges pressed. The listed players are banned.</p>;
  }

  const chargedNames = participants.filter((p) => checked.has(p.dayzId)).map((p) => p.gamertag).join(", ");

  if (armed) {
    return (
      <div role="status" className="flex flex-col gap-3">
        <p className="text-sm leading-relaxed text-ink-2">
          This automatically bans <span className="text-ink">{chargedNames || "nobody — pick at least one player"}</span> for at least <span className="text-ink">{minTermLabel}</span> each — doubled on a repeat offence, and <span className="text-ink">permanent</span> on a third upheld report this season. Prior offences are checked when you confirm, so a permanent ban can happen on THIS click without further warning. There is no further review after you confirm.
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={btnDanger} disabled={busy || checked.size === 0} onClick={() => void submit()}>
            {busy ? "Pressing charges…" : "Confirm — press charges"}
          </button>
          <button type="button" className={btnQuiet} disabled={busy} onClick={disarm}>Cancel</button>
        </div>
        {error && <p className="text-sm text-rust-2">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {participants.length > 1 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs uppercase tracking-[0.14em] text-muted">Charge</legend>
          {participants.map((p) => (
            <label key={p.dayzId} className="flex items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" checked={checked.has(p.dayzId)} onChange={() => toggle(p.dayzId)} />
              {p.gamertag}
            </label>
          ))}
        </fieldset>
      )}
      <button
        type="button"
        className={btnDanger}
        disabled={checked.size === 0}
        onClick={() => {
          setArmed(true);
          timer.current = setTimeout(() => setArmed(false), ARM_MS);
        }}
      >
        Press charges
      </button>
      {error && <p className="text-sm text-rust-2">{error}</p>}
    </div>
  );
}
