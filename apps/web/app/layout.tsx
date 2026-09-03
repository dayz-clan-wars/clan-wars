import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clan Wars",
  description: "Factions, territory and consequence on a DayZ server.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
