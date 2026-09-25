"use client";
import { useSyncExternalStore } from "react";

/** ⚠️ Tailwind's `lg` (64rem = 1024px). Two statements of one breakpoint; test/wide-only.test.ts pins this one. */
const QUERY = "(min-width: 1024px)";

const subscribe = (onChange: () => void) => {
  const m = window.matchMedia(QUERY);
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
};

/**
 * Children that exist only on a desktop-width screen. Not `hidden lg:block`:
 * a browser fetches every <img> in a CSS-hidden subtree, so a phone paid for
 * pictures it never showed (H5). The server snapshot is `false`, so the server
 * renders nothing and hydration agrees; a wide screen mounts the children one
 * render later. Use it only for content below the fold that is also reachable
 * elsewhere (the pool is on /clans in full).
 */
export function WideOnly({ children }: { children: React.ReactNode }) {
  const wide = useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
  return wide ? <>{children}</> : null;
}
