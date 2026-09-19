/**
 * Results only /notifications can produce.
 *
 * ⚠️ A null-prototype object, for the same reason RESULT_COPY is one: these are
 * looked up by a key that arrives in a query string, and a plain object would let
 * `?result=__proto__` reach Object.prototype.
 */
export const NOTIFICATIONS_RESULT_COPY: Record<string, string> = Object.assign(Object.create(null), {
  "notice.invite-gone": "That invite is no longer open. It may have been withdrawn or it ran out.",
  "notice.bad-input": "That action did not come through. Try it from the page it belongs to.",
});

/** A live target vanished between the page rendering and the button being pressed. */
export function gone(what: string): string {
  return `notice.${what}-gone`;
}
