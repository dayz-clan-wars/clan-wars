"use client";
import { useState } from "react";
import { field, kickerSm } from "./ui";

/** A gamertag box that goes to that player's page. No API — the profile route is the lookup. */
export function FindPlayer() {
  const [q, setQ] = useState("");
  return (
    <form className="flex h-full flex-col justify-center gap-2.5 border-2 border-rule-2 bg-frame p-5"
      onSubmit={(e) => { e.preventDefault(); const g = q.trim(); if (g) window.location.assign(`/players/${encodeURIComponent(g)}`); }}>
      <label className={kickerSm} htmlFor="find-player">Find a player</label>
      <input id="find-player" className={`${field} !mt-0`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Gamertag" autoComplete="off" spellCheck={false} />
      <p className="text-[13px] leading-relaxed text-muted">Every player the server has seen has a stat line, linked or not.</p>
    </form>
  );
}
