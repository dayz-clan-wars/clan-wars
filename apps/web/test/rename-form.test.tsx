import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { RenameForm } from "../app/(site)/clan/settings/rename-form";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", ...p), "utf8");
const input = (html: string, needle: string) => html.match(new RegExp(`<input[^>]*${needle}[^>]*/>`, "u"))?.[0] ?? "";

describe("rename keeps the refused name under its refusal (H2)", () => {
  it("shows the typed name, not the current one, beside 'Another clan has that name.'", () => {
    const html = renderToStaticMarkup(<RenameForm name="Bears" tag="BEAR" err={{ field: "name", message: "Another clan has that name." }} kept={{ name: "Wolves & Co", tag: "WOLF" }} />);
    expect(input(html, 'name="name"')).toContain('value="Wolves &amp; Co"');
    expect(input(html, 'name="name"')).toContain('aria-invalid="true"');
    expect(input(html, 'name="tag"')).toContain('value="WOLF"');
    expect(html).toContain("Another clan has that name.");
  });

  it("shows the clan's own name and tag when nothing was refused", () => {
    const html = renderToStaticMarkup(<RenameForm name="Bears" tag="BEAR" err={null} kept={{}} />);
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
