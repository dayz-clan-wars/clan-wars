import { describe, it, expect } from "vitest";
import { INSTALL_DISMISS_MS, installState, isIosBrowser } from "../lib/install";

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const now = 1_800_000_000_000;
const base = { ua: ANDROID, standalone: false, canPrompt: false, dismissedAt: null, now };

describe("installState", () => {
  it("never prompts once the site runs from the home screen", () => {
    expect(installState({ ...base, standalone: true, canPrompt: true })).toBe("installed");
    expect(installState({ ...base, ua: IOS, standalone: true })).toBe("installed");
  });

  it("offers the browser's own prompt when it fired, and the Share route on iPhone", () => {
    expect(installState({ ...base, canPrompt: true })).toBe("prompt");
    expect(installState({ ...base, ua: IOS })).toBe("ios");
    expect(isIosBrowser(IOS)).toBe(true);
    expect(isIosBrowser(ANDROID)).toBe(false);
  });

  it("shows nothing on a browser with neither", () => {
    expect(installState(base)).toBe("hidden");
  });

  it("⚠️ a dismissal holds for a month, then the offer is made again", () => {
    expect(installState({ ...base, ua: IOS, dismissedAt: now - 1000 })).toBe("hidden");
    expect(installState({ ...base, canPrompt: true, dismissedAt: now - INSTALL_DISMISS_MS + 1 })).toBe("hidden");
    expect(installState({ ...base, ua: IOS, dismissedAt: now - INSTALL_DISMISS_MS })).toBe("ios");
  });
});
