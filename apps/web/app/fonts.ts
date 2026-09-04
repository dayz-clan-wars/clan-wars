import { Archivo, Archivo_Black, Space_Mono } from "next/font/google";

/**
 * ⚠️ Self-hosted at build time by `next/font`, not linked from Google's CDN the
 * way the design canvas did it. Three faces carry the whole visual identity
 * here — a failed fetch would not merely degrade the shell, it would erase the
 * distinction between a display heading and a mono caption, which is most of
 * what tells the screens apart.
 */

export const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-archivo",
  display: "swap",
});

/** Display face. One weight is all Archivo Black ships. */
export const archivoBlack = Archivo_Black({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-archivo-black",
  display: "swap",
});

export const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-space-mono",
  display: "swap",
});
