"use client";

import { useEffect, useRef, useState } from "react";
import { btnDanger, btnQuiet } from "@/app/components/ui";

const ARM_MS = 8_000;

/**
 * Presses charges on one witnessed incident. ⚠️ Deliberately free of any
 * roster-package import — `next build` is the only thing that catches a
 * client component pulling that package's pooled postgres client into the
 * browser bundle ("Can't resolve 'fs'"), which no typecheck or vitest run
 * catches (broke a deploy on 2026-09-13). Everything this component needs is
 * a prop.
 *
 * This is a real safety control, not decoration: a bare click on
 * `reportIncident` bans every named player with no staff adjudicator in the
 * loop. The first press only arms the button and states, in words, who gets
 * banned and for how long at minimum; nothing is sent to the server until
 * the second press, within `ARM_MS`.
 */
export function ReportButton({ incidentId, gamertags, minTermLabel }: { incidentId: number; gamertags: string[]; minTermLabel: string }) {
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

  const submit = async () => {
    disarm();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/base/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ incidentId }),
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

  const names = gamertags.join(", ");

  if (armed) {
    return (
      <div role="status" className="flex flex-col gap-3">
        <p className="text-sm leading-relaxed text-ink-2">
          This automatically bans <span className="text-ink">{names}</span> for at least <span className="text-ink">{minTermLabel}</span> each — longer for a repeat offender. There is no further review after you confirm.
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={btnDanger} disabled={busy} onClick={() => void submit()}>
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
      <button
        type="button"
        className={btnDanger}
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
