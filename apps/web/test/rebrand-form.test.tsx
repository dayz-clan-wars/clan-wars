import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { RebrandForm } from "../app/(site)/clan/settings/rebrand-form";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", ...p), "utf8");
const input = (html: string, needle: string) => html.match(new RegExp(`<input[^>]*${needle}[^>]*/>`, "u"))?.[0] ?? "";

const NOW = new Date("2026-10-13T12:00:00Z");
const render = (pending: { texture: string; until: Date } | null, freeFlags: string[], now = NOW) => renderToStaticMarkup(
  <RebrandForm name="Bears" tag="BEAR" texture="Flag_Bear" freeFlags={freeFlags} pending={pending} err={null} kept={{}} now={now} />,
);

describe("the rebrand panel", () => {
  it("offers keep-current plus the free flags, posting texture", () => {
    const html = render(null, ["Flag_Rex", "Flag_Wolf"]);
    expect(html).toContain('action="/api/clan/rename"');
    // React prints a default-checked radio's `checked` before its value, so match the tag, not the attribute run.
    expect(input(html, 'name="texture"[^>]*value=""')).toContain('checked=""');
    expect(html).toContain('value="Flag_Wolf"');
    expect(html).toContain("Keep Bear");
  });

  it("while a change is pending, shows it with a cancel button and no form", () => {
    const html = render({ texture: "Flag_Wolf", until: new Date("2026-10-14T12:00:00Z") }, []);
    expect(html).toContain("Wolf");
    expect(html).toContain("UTC");
    expect(html).toContain('action="/api/clan/rebrand/cancel"');
    expect(html).not.toContain('action="/api/clan/rename"');
    expect(html).toContain("Raise it at your pole by");
  });

  it("past the deadline, says so instead of asking for a raise by a time already gone", () => {
    const html = render({ texture: "Flag_Wolf", until: new Date("2026-10-13T11:00:00Z") }, []);
    expect(html).not.toContain("Raise it at your pole by");
    expect(html).toContain("has passed");
    expect(html).toContain("goes back to the pool shortly");
    expect(html).toContain('action="/api/clan/rebrand/cancel"');
  });
});

describe("rename keeps the refused name under its refusal (H2)", () => {
  it("shows the typed name, not the current one, beside 'Another clan has that name.'", () => {
    const html = renderToStaticMarkup(<RebrandForm name="Bears" tag="BEAR" texture="Flag_Bear" freeFlags={[]} pending={null} err={{ field: "name", message: "Another clan has that name." }} kept={{ name: "Wolves & Co", tag: "WOLF" }} />);
    expect(input(html, 'name="name"')).toContain('value="Wolves &amp; Co"');
    expect(input(html, 'name="name"')).toContain('aria-invalid="true"');
    expect(input(html, 'name="tag"')).toContain('value="WOLF"');
    expect(html).toContain("Another clan has that name.");
  });

  it("shows the clan's own name and tag when nothing was refused", () => {
    const html = renderToStaticMarkup(<RebrandForm name="Bears" tag="BEAR" texture="Flag_Bear" freeFlags={[]} pending={null} err={null} kept={{}} />);
    expect(input(html, 'name="name"')).toContain('value="Bears"');
    expect(input(html, 'name="tag"')).toContain('value="BEAR"');
  });
});

describe("invite and guest pass keep their gamertag (H2)", () => {
  it("the invite field is refilled", () => expect(read("app", "(site)", "clan", "page.tsx")).toContain('defaultValue={kept.get("gamertag")}'));
  it("the guest field is refilled", () => expect(read("app", "(site)", "clan", "settings", "page.tsx")).toContain('defaultValue={kept.get("target")}'));
  it("the routes send it back only on a refusal", () => {
    expect(read("app", "api", "clan", "invite", "route.ts")).toContain('outcome === "ok" ? code("invite", outcome) : { back: "/clan", code: code("invite", outcome), keep: { gamertag } }');
    expect(read("app", "api", "clan", "guest", "route.ts")).toContain('outcome === "ok" ? code("guest", outcome) : { back: "/clan/settings", code: code("guest", outcome), keep: { target } }');
  });
});
