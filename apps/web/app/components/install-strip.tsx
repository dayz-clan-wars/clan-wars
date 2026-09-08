"use client";
import { useEffect, useState } from "react";
import { INSTALL_DISMISS_KEY, installState, type InstallState } from "@/lib/install";

/** Chrome's `beforeinstallprompt` event, which the DOM lib does not type. */
type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

function readDismissed(): number | null {
  try {
    const v = window.localStorage.getItem(INSTALL_DISMISS_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

/**
 * The home-screen offer, phones only, under the top bar. Android gets an
 * Install button that calls the browser's own prompt; iPhone gets the
 * Share → Add to Home Screen route, since Safari has no install API. "Not
 * now" hides it for a month (lib/install.ts). Gone entirely once the site
 * runs from the home screen.
 */
export function InstallStrip() {
  const [state, setState] = useState<InstallState>("hidden");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean };
    const standalone = window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
    const facts = (canPrompt: boolean) => ({ ua: navigator.userAgent, standalone, canPrompt, dismissedAt: readDismissed(), now: Date.now() });
    setState(installState(facts(false)));
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setState(installState(facts(true)));
    };
    const onInstalled = () => setState("installed");
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (state !== "ios" && state !== "prompt") return null;

  const dismiss = () => {
    try { window.localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now())); } catch { /* a convenience */ }
    setState("hidden");
  };
  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === "accepted") setState("installed");
    else dismiss();
  };

  return (
    <div role="region" aria-label="Install" className="flex items-center gap-3 border-b-2 border-rule-2 bg-frame px-4 py-2 lg:hidden">
      <img src="/icon.png" alt="" width={28} height={28} className="flex-none" />
      <p className="m-0 min-w-0 flex-1 text-[13px] leading-snug text-ink">
        {state === "prompt"
          ? <>Put <span className="font-display uppercase">Clan Wars</span> on your home screen.</>
          : <>Put <span className="font-display uppercase">Clan Wars</span> on your home screen: <span className="text-gold">Share → Add to Home Screen</span>.</>}
      </p>
      {state === "prompt" && (
        <button type="button" onClick={() => void install()} className="flex min-h-[44px] flex-none items-center bg-gold px-3 font-display text-xs uppercase tracking-[0.06em] text-ground">Install</button>
      )}
      <button type="button" onClick={dismiss} className="flex min-h-[44px] flex-none items-center font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-ink" aria-label="Not now">✕</button>
    </div>
  );
}
