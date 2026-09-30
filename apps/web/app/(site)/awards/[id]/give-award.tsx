"use client";
import { useState } from "react";
import { GamertagField } from "@/app/components/gamertag-field";
import { btnPrimary } from "@/app/components/ui";
import { lookupCopy } from "@/lib/copy-lookup";
import { RESULT_COPY } from "@/lib/award-copy";

/**
 * Give this award to another linked player: name them, confirm, done.
 *
 * ⚠️ Two steps on purpose. The give is instant and cannot be undone, so the
 * confirm names both the award and the player before anything is sent.
 */
export function GiveAward({ grantId, label }: { grantId: number; label: string }) {
  const [stage, setStage] = useState<"closed" | "name" | "confirm">("closed");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const give = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/awards/${grantId}/give`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gamertag: to }),
      }).catch(() => null);
      if (res?.status === 401) { window.location.assign(`/login?next=/awards/${grantId}`); return; }
      const out = (await res?.json().catch(() => null)) as { ok?: boolean; reason?: string } | null;
      if (out?.ok) { window.location.assign("/awards"); return; }
      setRefusal((typeof out?.reason === "string" ? lookupCopy(RESULT_COPY, out.reason) : undefined) ?? RESULT_COPY.failed!);
      setStage("name");
    } finally {
      setBusy(false);
    }
  };

  if (stage === "closed") {
    return (
      <button type="button" className="mt-5 text-[13px] text-gold underline-offset-4 hover:underline" onClick={() => setStage("name")}>
        Give to another player
      </button>
    );
  }
  if (stage === "confirm") {
    return (
      <div className="mt-5 max-w-[34rem] border border-rule-2 bg-frame p-3.5">
        <p className="text-[13px] leading-relaxed text-ink">Give your {label} to {to}? You can&apos;t undo this.</p>
        <div className="mt-3 flex gap-3">
          <button type="button" className={btnPrimary} disabled={busy} onClick={() => { void give(); }}>Give it to {to}</button>
          <button type="button" className="text-[13px] text-ink-2" disabled={busy} onClick={() => setStage("name")}>Back</button>
        </div>
      </div>
    );
  }
  return (
    <form className="mt-5 max-w-[34rem]" onSubmit={(e) => {
      e.preventDefault();
      const name = String(new FormData(e.currentTarget).get("gamertag") ?? "").trim();
      if (!name) return;
      setTo(name); setRefusal(null); setStage("confirm");
    }}>
      <label className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted" htmlFor="give-to">Give it to</label>
      <GamertagField scope="linked" name="gamertag" id="give-to" defaultValue={to} required autoFocus />
      {refusal && <p role="alert" className="mt-2 text-[13px] text-rust">{refusal}</p>}
      <div className="mt-3 flex gap-3">
        <button type="submit" className={btnPrimary}>Next</button>
        <button type="button" className="text-[13px] text-ink-2" onClick={() => { setStage("closed"); setRefusal(null); }}>Cancel</button>
      </div>
    </form>
  );
}
