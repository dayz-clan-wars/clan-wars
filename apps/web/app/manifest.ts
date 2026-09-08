import type { MetadataRoute } from "next";

/**
 * The web app manifest, so a phone can put Clan Wars on its home screen with
 * the logo rather than a screenshot. Served at /manifest.webmanifest, which
 * the auth gate lists as public along with /icons/ — an anonymous visitor's
 * browser fetches it before any login.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Clan Wars",
    short_name: "Clan Wars",
    description: "Clans, bases and consequence on a DayZ server.",
    start_url: "/",
    display: "standalone",
    background_color: "#050505",
    theme_color: "#0b0b0a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
