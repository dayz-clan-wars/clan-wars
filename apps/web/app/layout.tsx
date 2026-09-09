import type { Metadata, Viewport } from "next";
import { archivo, archivoBlack, spaceMono } from "./fonts";
import "./globals.css";
import { SITE_NAME, SITE_TAGLINE, SITE_DESCRIPTION } from "@/lib/site-meta";

export const metadata: Metadata = {
  // Absolute base for the share images below; Next resolves the file-convention
  // paths against it, and without it the og:image is a relative URL that
  // Discord and Twitter refuse.
  metadataBase: new URL("https://dayzclanwars.com"),
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  // The share card reads "Your clan. Your war." — the preview's title says
  // the same, so the text under the picture does not repeat the site name.
  openGraph: { siteName: SITE_NAME, title: `${SITE_NAME} — ${SITE_TAGLINE}`, description: SITE_DESCRIPTION, type: "website", url: "/" },
  twitter: { card: "summary_large_image", title: `${SITE_NAME} — ${SITE_TAGLINE}`, description: SITE_DESCRIPTION },
  // Share previews come from opengraph-image.png and twitter-image.png beside
  // this file (1200x630, the "Your clan. Your war." card), one image for the
  // whole site.
  // The icons come from the file conventions beside this file: favicon.ico
  // and icon.png (the CW monogram, for tabs), apple-icon.png (the logo, for
  // a phone's home screen), manifest.ts (the same logo at 192 and 512).
};

/** The browser chrome colour on phones: the panel frame, not the page ground. */
export const viewport: Viewport = { themeColor: "#0b0b0a" };

/**
 * The three font variables ride on <html> so @theme's --font-* tokens
 * resolve everywhere, including portals and the 404 page. The site's top bar
 * and menu live one level down, in app/(site)/layout.tsx, so the static
 * landing page and guide stay outside it.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${archivoBlack.variable} ${spaceMono.variable}`}>
      <body className="bg-ground text-ink font-sans antialiased">{children}</body>
    </html>
  );
}
