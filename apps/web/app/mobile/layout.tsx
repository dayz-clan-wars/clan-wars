import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Clan Wars — mobile",
  /**
   * ⚠️ Noindex. The screens are fixtures, and a search result promising a
   * faction map that shows invented rosters is worse than no result at all.
   */
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0b0a",
};

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return children;
}
