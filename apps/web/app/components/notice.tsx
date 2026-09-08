"use client";

import { useEffect, useRef } from "react";

/**
 * A status line — the result of a form post, looked up from copy.
 *
 * Every action on the site is a plain form POST that redirects back with a
 * `?result=` code, so the notice arrives on a fresh page load, where a
 * `role="status"` region is NOT announced (live regions only speak when they
 * change). Moving keyboard focus onto it on mount makes a screen reader read
 * it, and puts a sighted keyboard user's next Tab right after it. `focus`
 * is on by default; pass `false` for a notice that is part of the page's
 * standing state (a reservation, a pending spot) rather than an answer.
 *
 * `tone="rust"` marks an open obligation — never a generic refusal, which
 * stays plain in this palette (frontend rebuild §4).
 */
export function Notice({ children, tone = "plain", focus = true }: { children: React.ReactNode; tone?: "plain" | "gold" | "rust"; focus?: boolean }) {
  const el = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (focus) el.current?.focus({ preventScroll: false }); }, [focus]);
  const edge = tone === "gold" ? "border-gold" : tone === "rust" ? "border-rust" : "border-rule-2";
  return (
    <p ref={el} role="status" tabIndex={-1} className={`border ${edge} bg-surface px-4 py-3 text-sm text-ink focus:outline-none focus-visible:outline-none`}>
      {children}
    </p>
  );
}
