"use client";

import { useEffect, useRef, useState } from "react";
import { guardFormSubmit } from "@/lib/submit-guard";

/**
 * The submit button for every plain form POST on the signed-in pages: it
 * sends its form once, then says it is busy until the next page arrives.
 *
 * ⚠️ `aria-disabled`, never `disabled`, once pending. A disabled submitter is
 * left out of the form's data if it disables before the entry list is built,
 * and a disabled button drops keyboard focus to <body>. The guard is what
 * stops the second POST; the attribute only says so.
 *
 * ⚠️ Server-rendered as a bare `<button type="submit">`. With JavaScript off
 * that is all there is, and the form still posts.
 */
export function SubmitButton({ className, children, pending: pendingLabel, disabled = false }: {
  className: string; children: React.ReactNode; pending?: React.ReactNode; disabled?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return undefined;
    return guardFormSubmit(form, window, setPending);
  }, []);
  return (
    // ⚠️ Styled off `data-pending`, never a class containing the literal word
    // "disabled". `report-button.tsx` and `link-flow.tsx` DO use an
    // `aria-disabled:opacity-40` variant for the same pending look, and it is
    // fine there — the variant only matches once `aria-disabled` is actually
    // present. It cannot be used HERE because the SSR test below does a
    // blunt substring check for the word "disabled" across the WHOLE
    // rendered markup, not just the attribute: a static class name like
    // `aria-disabled:opacity-40` is written into `class="…"` verbatim
    // whether or not the attribute ever fires, and that alone trips the
    // check on the idle, enabled render. `data-pending` sidesteps it because
    // nothing in its name contains the word.
    <button ref={ref} type="submit" className={`${className} [&[data-pending]]:opacity-40`} disabled={disabled}
      data-pending={pending || undefined} aria-disabled={pending || undefined} aria-busy={pending || undefined}>
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </button>
  );
}
