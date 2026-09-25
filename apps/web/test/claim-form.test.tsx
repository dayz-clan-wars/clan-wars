import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaimForm, type ClaimKept } from "../app/(site)/claim/[ceremony]/claim-form";
import type { FieldError } from "../lib/field-errors";

const PARTS = [{ dayzId: "me", gamertag: "Ronald" }, { dayzId: "p2", gamertag: "Ada" }, { dayzId: "p3", gamertag: "Bo" }];
const render = (o: { err?: FieldError | null; kept?: ClaimKept } = {}) => renderToStaticMarkup(
  <ClaimForm ceremonyId={7} freeFlags={["Flag_Bear", "Flag_Wolf"]} participants={PARTS} meDayzId="me" err={o.err ?? null} kept={o.kept ?? { members: [] }} />,
);
/** The one <input …/> tag containing `needle`. */
const input = (html: string, needle: string) => html.match(new RegExp(`<input[^>]*${needle}[^>]*/>`, "u"))?.[0] ?? "";

describe("the claim form keeps what the founder typed (H2)", () => {
  /** ⚠️ Review focus 2: the typed value reaches the field escaped, and whole. */
  it("⚠️ refills name and tag, HTML-escaped", () => {
    const html = render({ kept: { name: "Iron & Ash ✦", tag: "IRON", members: [] } });
    expect(input(html, 'name="name"')).toContain('value="Iron &amp; Ash ✦"');
    expect(input(html, 'name="tag"')).toContain('value="IRON"');
  });

  it("re-picks the kept flag while it is still free", () => {
    const html = render({ kept: { texture: "Flag_Wolf", members: [] } });
    expect(input(html, 'value="Flag_Wolf"')).toContain('checked=""');
    expect(input(html, 'value="Flag_Bear"')).not.toContain('checked=""');
  });

  it("picks nothing when the kept flag has been taken since", () => {
    expect(render({ kept: { texture: "Flag_Gone", members: [] } })).not.toMatch(/<input type="radio"[^>]*checked=""/u);
  });

  it("keeps an unticked founder unticked", () => {
    const html = render({ kept: { members: ["me", "p2"] } });
    expect(input(html, 'value="p2"')).toContain('checked=""');
    expect(input(html, 'value="p3"')).not.toContain('checked=""');
  });

  it("ticks everyone when there is nothing to restore", () => {
    const html = render();
    expect(input(html, 'value="p2"')).toContain('checked=""');
    expect(input(html, 'value="p3"')).toContain('checked=""');
  });
});

describe("a flag or roster refusal takes focus (H3)", () => {
  it("focuses the first flag and ties the group to the sentence", () => {
    const html = render({ err: { field: "texture", message: "Pick one of the free flags." } });
    expect(input(html, 'value="Flag_Bear"')).toContain('autofocus=""');
    expect(html).toContain('aria-describedby="err-texture"');
    expect(html).toContain("Pick one of the free flags.");
  });

  it("focuses the first founder the claimant can untick, never their own locked box", () => {
    const html = render({ err: { field: "member", message: "The roster must be people who were at the ceremony, and must include you." } });
    expect(input(html, 'value="p2"')).toContain('autofocus=""');
    expect(input(html, 'type="checkbox"[^>]*value="me"')).not.toContain("autofocus");
  });
});

describe("L4", () => {
  it("puts the legend first in the roster fieldset", () => {
    expect(render({ err: { field: "member", message: "x" } })).toMatch(/<fieldset aria-describedby="err-member"><legend/u);
  });
  it("gives the flag picture an empty alt — the name is printed under it", () => {
    const html = render();
    expect(html).not.toContain('alt="Flag_Bear"');
    expect(html).toContain('alt=""');
  });
  it("marks the chosen flag with a glyph as well as a colour", () => {
    expect(render()).toContain("group-has-[:checked]:flex");
  });
});

describe("the claim route", () => {
  const ROUTE = readFileSync(join(import.meta.dirname, "..", "app", "api", "claim", "route.ts"), "utf8");
  it("keeps the roster it was sent on every refusal", () => expect(ROUTE).toContain("member: members"));
});
