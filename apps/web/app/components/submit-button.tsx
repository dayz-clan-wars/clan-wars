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
    // "disabled" (an `aria-disabled:` variant would fire even server-rendered,
    // since the string is static) — the SSR test pins a plain enabled button.
    <button ref={ref} type="submit" className={`${className} [&[data-pending]]:opacity-40`} disabled={disabled}
      data-pending={pending || undefined} aria-disabled={pending || undefined} aria-busy={pending || undefined}>
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </button>
  );
}
