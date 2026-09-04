import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Clan Wars — link your character",
  /**
   * ⚠️ Noindex, for a sharper reason than the mobile shell's. This route
   * imitates a sign-in: a search result headed "Link your character" would put
   * a player in front of a Continue-with-Discord button that authenticates
   * nothing. An unindexed prototype is a preview; an indexed one is bait.
   */
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#050505",
};

export default function LinkLayout({ children }: { children: React.ReactNode }) {
  return children;
}
