import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GuestPassList } from "../app/(site)/clan/settings/guest-passes";

const at = new Date("2026-09-25T12:00:00Z");

describe("the guest pass list (M5)", () => {
  it("names a linked guest by gamertag and hides the id", () => {
    const html = renderToStaticMarkup(<GuestPassList passes={[{ id: 1, userDiscordId: "123456789012345678", userGamertag: "Gus", grantedBy: "Otto", expiresAt: at }]} />);
    expect(html).toContain("Gus");
    expect(html).not.toContain("123456789012345678");
    expect(html).toContain("granted by Otto");
  });

  it("falls back to 'Discord user' and the id, muted, for a guest who never linked", () => {
    const html = renderToStaticMarkup(<GuestPassList passes={[{ id: 1, userDiscordId: "123456789012345678", userGamertag: null, grantedBy: "Otto", expiresAt: at }]} />);
    expect(html).toContain("Discord user");
    expect(html).toContain("123456789012345678");
  });

  it("says so when there are none", () => expect(renderToStaticMarkup(<GuestPassList passes={[]} />)).toContain("No open passes."));
});
