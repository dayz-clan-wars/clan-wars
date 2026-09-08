/**
 * Whether, and how, to offer "put Clan Wars on your home screen". Pure, so
 * the decision is testable; the component supplies the browser facts.
 *
 *  - `installed`: already running from the home screen (display-mode
 *    standalone, or Safari's `navigator.standalone`). Never prompt.
 *  - `ios`: iPhone or iPad Safari. There is no install API; the strip shows
 *    the Share → Add to Home Screen route.
 *  - `prompt`: the browser fired `beforeinstallprompt` (Chrome on Android),
 *    so the strip can offer a real Install button.
 *  - `hidden`: everything else, including a recent dismissal. Desktop never
 *    sees the strip: the component is `lg:hidden` as well.
 */
export type InstallState = "hidden" | "installed" | "ios" | "prompt";

export const INSTALL_DISMISS_KEY = "clan-wars.install.dismissed";
/** A "Not now" holds for a month; then the offer is made once more. */
export const INSTALL_DISMISS_MS = 30 * 24 * 3600_000;

export function isIosBrowser(ua: string): boolean {
  // iPadOS 13+ presents as a Mac; the touch-points check in the component
  // catches that, but the UA alone is enough for phones.
  return /iPhone|iPad|iPod/u.test(ua);
}

export function installState(f: { ua: string; standalone: boolean; canPrompt: boolean; dismissedAt: number | null; now: number }): InstallState {
  if (f.standalone) return "installed";
  if (f.dismissedAt !== null && f.now - f.dismissedAt < INSTALL_DISMISS_MS) return "hidden";
  if (f.canPrompt) return "prompt";
  if (isIosBrowser(f.ua)) return "ios";
  return "hidden";
}
