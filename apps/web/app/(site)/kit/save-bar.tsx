"use client";

import { useEffect, useRef, useState } from "react";
import type { KitSlot } from "@factions/domain";
import { btnPrimary } from "@/app/components/ui";
import { unsavedKitNotice, UNSAVED_LEAVE_WARNING } from "@/lib/kit-copy";

/**
 * The single Save button for the whole kit, plus an unsaved-changes notice.
 *
 * ⚠️ A pure enhancement over the plain `<form action={saveKit}>` in page.tsx.
 * The button below is a normal `type="submit"` inside that form, so it saves
 * the kit with JavaScript off exactly as it did before this component
 * existed. Everything in this file — the notice, the tab-close warning — is
 * layered on top and must degrade to nothing: with no hydration, `unsaved`
 * never leaves 0, so the notice never renders and no listener is ever
 * attached.
 */
export function KitSaveBar({ formId, slots }: { formId: string; slots: readonly KitSlot[] }) {
  const [unsaved, setUnsaved] = useState(0);
  // Holds the exact function instance handed to addEventListener, so the
  // submit handler below can remove that SAME instance rather than a
  // same-shaped one that `removeEventListener` would silently ignore.
  const beforeUnloadRef = useRef<((e: BeforeUnloadEvent) => void) | null>(null);

  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return undefined;

    const currentPicks = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const slot of slots) {
        const checked = form.querySelector<HTMLInputElement>(`input[name="className-${slot}"]:checked`);
        out[slot] = checked?.value ?? "";
      }
      return out;
    };
    // What was saved, captured once at mount — the page always renders the
    // saved picks as `defaultChecked`, so the DOM at mount IS the saved state.
    const saved = currentPicks();

    const recompute = () => {
      const now = currentPicks();
      setUnsaved(slots.filter((slot) => now[slot] !== saved[slot]).length);
    };
    form.addEventListener("change", recompute);

    // ⚠️ Dropped the instant the form submits, before the navigation that
    // follows. Left attached, it would fire `beforeunload` on the very save
    // the player just asked for, warning them about leaving mid-save.
    const onSubmit = () => {
      if (beforeUnloadRef.current) window.removeEventListener("beforeunload", beforeUnloadRef.current);
      beforeUnloadRef.current = null;
    };
    form.addEventListener("submit", onSubmit);

    return () => {
      form.removeEventListener("change", recompute);
      form.removeEventListener("submit", onSubmit);
    };
  }, [formId, slots]);

  useEffect(() => {
    if (unsaved === 0) return undefined;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = UNSAVED_LEAVE_WARNING;
    };
    beforeUnloadRef.current = handler;
    window.addEventListener("beforeunload", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
      if (beforeUnloadRef.current === handler) beforeUnloadRef.current = null;
    };
  }, [unsaved]);

  return (
    <div
      className="sticky bottom-0 z-10 flex flex-col gap-2 border-t-2 border-rule-2 bg-paper px-4 py-3 lg:px-5"
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
    >
      {unsaved > 0 && (
        <p role="status" className="text-xs text-gold">{unsavedKitNotice(unsaved)}</p>
      )}
      <button type="submit" form={formId} className={btnPrimary}>Save kit</button>
    </div>
  );
}
