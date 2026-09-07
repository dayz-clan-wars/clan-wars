"use client";

import { useEffect, useRef, useState } from "react";

const REVEAL_MS = 30_000;

/**
 * The one button that ever shows a vault code. POSTs JSON so the code
 * never rides a URL or a redirect; shown for 30 s then hidden again, so a
 * stream that catches this frame catches nothing for long.
 */
export function RevealButton({ lockId }: { lockId: number }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

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
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCode(null), REVEAL_MS);
    } catch {
      setError("Could not reveal that lock.");
    } finally {
      setBusy(false);
    }
  };

  // `role="status"` on the wrapper, not on the code or the error alone: the
  // live region has to be in the DOM BEFORE its content changes for a screen
  // reader to announce it, and this element is. It is the one place either
  // outcome — the revealed code, or the refusal — appears.
  if (code) {
    return (
      <div role="status" className="flex items-center gap-2">
        <span className="font-mono text-lg tracking-[0.2em] text-gold">{code}</span>
      </div>
    );
  }

  return (
    <div role="status" className="flex items-center gap-2">
      <button type="button" className="min-h-[44px] rounded-md border border-rule px-3 font-display text-sm text-ink" onClick={reveal} disabled={busy}>
        {busy ? "Revealing…" : "Reveal code"}
      </button>
      {error && <span className="text-xs text-ink-2">{error}</span>}
    </div>
  );
}
