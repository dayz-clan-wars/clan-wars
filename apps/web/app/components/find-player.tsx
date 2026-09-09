"use client";
import { kickerSm } from "./ui";
import { GamertagField } from "./gamertag-field";

/** A gamertag box that goes to that player's page. The profile route is the lookup; the box only suggests names. */
export function FindPlayer() {
  return (
    <form className="flex h-full flex-col justify-center gap-2.5 border-2 border-rule-2 bg-frame p-5"
      onSubmit={(e) => { e.preventDefault(); const g = String(new FormData(e.currentTarget).get("gamertag") ?? "").trim(); if (g) window.location.assign(`/players/${encodeURIComponent(g)}`); }}>
      <label className={kickerSm} htmlFor="find-player">Find a player</label>
      <GamertagField scope="seen" id="find-player" name="gamertag" className="!mt-0" />
      <p className="text-[13px] leading-relaxed text-muted">Every player the server has seen has a stat line, linked or not.</p>
    </form>
  );
}
