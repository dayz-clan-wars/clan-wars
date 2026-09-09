"use client";

import { useEffect, useRef, useState } from "react";

const ARM_MS = 4_000;

/**
 * A submit button for the one-click removals — kick, demote, withdraw an
 * invite, revoke a pass — that need a confirmation but not a checkbox: the
 * first press arms it and swaps the label for `confirm` ("Remove?"), the
 * second press within four seconds submits the form it sits in. Nothing
 * happens if the player looks away; it disarms itself.
 *
 * No dialog: a `confirm()` blocks the page and reads badly on a phone, and
 * the site's forms otherwise never need script to submit.
 */
export function ConfirmButton({ confirm, className, children, disabled = false }: { confirm: string; className: string; children: React.ReactNode; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button type="submit" className={className} aria-live="polite" disabled={disabled}
      onClick={(e) => {
        if (armed) return;
        e.preventDefault();
        setArmed(true);
        timer.current = setTimeout(() => setArmed(false), ARM_MS);
      }}
      onBlur={() => { if (timer.current) clearTimeout(timer.current); setArmed(false); }}>
      {armed ? confirm : children}
    </button>
  );
}
