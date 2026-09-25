/** The two things the guard listens to: the form, and the window for pageshow. */
export type SubmitTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * Let a form post once (H1, UX review 2026-09-24).
 *
 * Every signed-in page posts plain HTML forms, so a second tap while the first
 * POST is in flight is a second POST — and some are not idempotent in effect:
 * the second "Found the clan" found no ceremony left and 404'd a founder whose
 * clan had just been created.
 *
 * ⚠️ Listens for `submit`, not `click`. `submit` fires only after the browser's
 * own validation passes (a required box left unticked fires nothing), and it
 * also catches Enter in a field, which a click handler never sees.
 *
 * ⚠️ `pageshow` with `persisted` resets it. Back from the next page restores
 * this one from the bfcache with its script state intact; without the reset
 * the button would stay dead until a reload.
 */
export function guardFormSubmit(form: SubmitTarget, win: SubmitTarget, onChange: (pending: boolean) => void): () => void {
  let sent = false;
  const onSubmit = (e: Event) => {
    if (e.defaultPrevented) return;
    if (sent) { e.preventDefault(); return; }
    sent = true;
    onChange(true);
  };
  const onShow = (e: Event) => {
    if ((e as Event & { persisted?: boolean }).persisted !== true) return;
    sent = false;
    onChange(false);
  };
  form.addEventListener("submit", onSubmit);
  win.addEventListener("pageshow", onShow);
  return () => {
    form.removeEventListener("submit", onSubmit);
    win.removeEventListener("pageshow", onShow);
  };
}
