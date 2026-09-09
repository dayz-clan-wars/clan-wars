"use client";
import { btnPrimary, kickerSm } from "./ui";
import { GamertagField } from "./gamertag-field";

/** A gamertag box that goes to that player's page: one row above the boards. The profile route is the lookup; the box only suggests names. */
export function FindPlayer() {
  return (
    <form className="flex flex-col gap-2.5 border-2 border-rule-2 bg-frame p-4 lg:flex-row lg:items-center lg:gap-5 lg:px-5"
      onSubmit={(e) => { e.preventDefault(); const g = String(new FormData(e.currentTarget).get("gamertag") ?? "").trim(); if (g) window.location.assign(`/players/${encodeURIComponent(g)}`); }}>
      <label className={`${kickerSm} flex-none`} htmlFor="find-player">Find a player</label>
      <div className="flex gap-2.5 lg:flex-1">
        <GamertagField scope="seen" id="find-player" name="gamertag" className="!mt-0" />
        <button className={`${btnPrimary} flex-none`} type="submit">Find</button>
      </div>
      <p className="text-[13px] leading-relaxed text-muted lg:flex-none">Every player the server has seen has a stat line, linked or not.</p>
    </form>
  );
}
