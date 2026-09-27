import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkFlow, ChooseCharacter } from "../app/(site)/link/link-flow";
import LoginPage from "../app/(site)/login/page";
import JoinPage from "../app/(site)/join/page";
import { btnSecondary, field } from "../app/components/ui";
import { REFERRAL_COPY } from "../lib/link-copy";
import { GAMERTAG_MAX } from "../lib/clan-limits";

type Initial = Parameters<typeof LinkFlow>[0]["initial"];
const flow = (initial: Initial) => renderToStaticMarkup(<LinkFlow initial={initial} />);
const LINKED = { link: { dayzId: "dz", gamertag: "Ada", verifiedAt: "2026-09-01T00:00:00.000Z" }, challenge: null, ended: null } as Initial;
const OPEN = {
  link: null, ended: null,
  challenge: { id: 1, targetDayzId: "dz", gamertag: "Ada", confirmed: 0, drawsLeft: 2, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    steps: [{ token: "salute", label: "salute", confirmed: false }] },
} as Initial;
const CHOOSE = { link: null, challenge: null, ended: "expired" } as Initial;

describe("M2: the verified screen's second button", () => {
  it("is the secondary button, with no gold hover under ink text", () => {
    const a = flow(LINKED).match(/<a[^>]*href="\/me"[^>]*>/u)?.[0] ?? "";
    expect(a).toContain(btnSecondary);
    expect(a).not.toContain("hover:bg-gold-hover");
  });
});

describe("L1: a refusal is not rust", () => {
  it("the 'Not issued' box uses the control edge", () => {
    const html = flow(CHOOSE);
    expect(html).toContain("Not issued");
    expect(html).not.toContain("border-rust");
  });
});

describe("L6: the countdown and the bullet", () => {
  const html = flow(OPEN);
  it("says 'left' on a phone, where 'Expires in' is hidden", () => expect(html).toContain('<span class="lg:hidden"> left</span>'));
  it("hides the decorative bullet from a screen reader", () => expect(html).toContain('<span aria-hidden="true" class="mr-3 text-rust-2">●</span>'));
});

describe("L5: one numbering, sign-in to proof", () => {
  it("login is step 1", async () => expect(renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }))).toContain("Step 1 of 3 — sign in"));
  it("joining the Discord is still step 1, not 'one step left'", async () => {
    const html = renderToStaticMarkup(await JoinPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Step 1 of 3 — join the Discord");
    expect(html).not.toContain("One step left");
  });
  it("naming the character is step 2", () => expect(flow(CHOOSE)).toContain("Step 2 of 3 — name your character"));
  it("the proof is step 3, and does not also say 'one step left'", () => {
    const html = flow(OPEN);
    expect(html).toContain("Step 3 of 3 — prove it");
    expect(html).not.toContain("one step left");
  });
});

describe("referrals: naming one while linking", () => {
  const chooseCharacter = (notice: string | null = null) =>
    renderToStaticMarkup(<ChooseCharacter notice={notice} busy={false} onClaim={() => {}} />);

  it("has the optional referrer field, with the shared field style and the gamertag cap", () => {
    const html = chooseCharacter();
    expect(html).toContain("Who referred you? (optional)");
    expect(html).toContain('aria-label="Who referred you"');
    expect(html).toContain(`maxLength="${GAMERTAG_MAX}"`);
    // The referrer input, not the gamertag search input above it, carries the shared `field` class.
    const referrerInput = html.match(/<input[^>]*aria-label="Who referred you"[^>]*>/u)?.[0] ?? "";
    for (const cls of field.split(" ")) expect(referrerInput).toContain(cls);
  });

  it("says the referrer becomes permanent once the link completes", () => {
    expect(chooseCharacter()).toContain("Permanent once your link completes.");
  });

  it("shows a referrer-refused notice with the shared REFERRAL_COPY wording, same as LinkFlow's start()", () => {
    const notice = REFERRAL_COPY.self({});
    const html = chooseCharacter(notice);
    expect(html).toContain("Not issued");
    // React escapes the apostrophe in server-rendered text.
    expect(html).toContain(notice.replace("'", "&#x27;"));
    expect(notice).not.toContain("—");
  });
});
