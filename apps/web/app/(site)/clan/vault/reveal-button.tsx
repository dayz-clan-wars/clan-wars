"use client";

import { useEffect, useRef, useState } from "react";
import { btnSecondary } from "@/app/components/ui";

const REVEAL_MS = 30_000;

/**
 * The one button that ever shows a vault code. POSTs JSON so the code
 * never rides a URL or a redirect; shown for 30 s then hidden again, so a
 * stream that catches this frame catches nothing for long. The seconds
 * left are counted down beside the code so the hiding is never a surprise.
 */
export function RevealButton({ lockId }: { lockId: number }) {
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => { if (timer.current) clearInterval(timer.current); timer.current = null; };
  useEffect(() => stop, []);

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/vault/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lockId }),
      });
      if (res.status === 401) { window.location.reload(); return; }
      const data = (await res.json()) as { code?: string; error?: string };
      if (!res.ok || !data.code) { setError(data.error ?? "Could not reveal that lock."); return; }
      setCode(data.code);
      const until = Date.now() + REVEAL_MS;
      setLeft(REVEAL_MS / 1000);
      stop();
      timer.current = setInterval(() => {
        const s = Math.ceil((until - Date.now()) / 1000);
        if (s <= 0) { stop(); setCode(null); return; }
        setLeft(s);
      }, 250);
    } catch {
      setError("Could not reveal that lock.");
    } finally {
      setBusy(false);
    }
  };

  // `role="status"` on the wrapper, not on the code or the error alone: the
  // live region has to be in the DOM BEFORE its content changes for a screen
  // reader to announce it, and this element is. It is the one place either
  // outcome — the revealed code, or the refusal — appears. The countdown is
  // kept OUT of it (aria-hidden) so a reader is not told a number every second.
  if (code) {
    return (
      <div role="status" className="flex min-h-[44px] flex-wrap items-center gap-3">
        <span className="font-mono text-lg tracking-[0.2em] text-gold">{code}</span>
        <span aria-hidden="true" className="font-mono text-xs tabular-nums text-muted">hides in {left} s</span>
        <button type="button" className="font-mono text-xs uppercase tracking-[0.18em] text-muted hover:text-ink" onClick={() => { stop(); setCode(null); }}>Hide now</button>
      </div>
    );
  }

  return (
    <div role="status" className="flex flex-wrap items-center gap-3">
      <button type="button" className={btnSecondary} onClick={reveal} disabled={busy}>
        {busy ? "Revealing…" : "Reveal code"}
      </button>
      {error && <span className="text-sm text-ink">{error}</span>}
    </div>
  );
}
