import type { Metadata } from "next";
import { archivo, archivoBlack, spaceMono } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clan Wars",
  description: "Clans, bases and consequence on a DayZ server.",
};

/**
 * The three font variables ride on <html> so @theme's --font-* tokens
 * resolve everywhere, including portals and the 404 page. Pages own their
 * own layout below this; there is no shared chrome yet.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${archivoBlack.variable} ${spaceMono.variable}`}>
      <body className="bg-ground text-ink font-sans antialiased">{children}</body>
    </html>
  );
}
