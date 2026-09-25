/**
 * The top bar's three popovers — the phone Menu drawer (menu-list.tsx), the
 * bell's panel (notifications-bell.tsx) and the guide's Contents
 * (app/guide/layout.tsx) — are one group: opening one closes the others.
 *
 * ⚠️ All three paint at z-[1300]; two open at once stack into something
 * nobody can read or dismiss. `name` on a <details> makes the group
 * exclusive natively in current browsers; `PopoverDismiss` enforces the same
 * rule for the ones that predate it, and adds Escape and click-outside.
 */
export const POPOVER_GROUP = "cw-popover";

/** When `opened` opens, the rest of the group closes. */
export function othersThan<T>(open: readonly T[], opened: T): T[] {
  return open.filter((d) => d !== opened);
}

/** Which open popovers a click at `target` closes: every one that does not contain it. */
export function toDismiss<T extends { contains(node: unknown): boolean }>(open: readonly T[], target: unknown): T[] {
  return open.filter((d) => !d.contains(target));
}
