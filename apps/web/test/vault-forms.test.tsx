import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AddLockForm, LockEditor, VaultCodeField } from "../app/(site)/clan/vault/lock-forms";
import { readKept } from "../lib/form";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", ...p), "utf8");
const input = (html: string, needle: string) => html.match(new RegExp(`<input[^>]*${needle}[^>]*/>`, "u"))?.[0] ?? "";
const LOCK = { id: 5, name: "Main gate", note: "north wall", minRole: "member" };

describe("the code field (M10)", () => {
  /** ⚠️ The page hides codes behind a tap so a stream never sees one; form history would offer it on focus. */
  it("⚠️ is never remembered by the browser or a password manager", () => {
    const tag = input(renderToStaticMarkup(<VaultCodeField err={null} />), 'name="code"');
    // React emits `autoComplete`; HTML attribute names are case-insensitive, so a browser reads it as `autocomplete`.
    expect(tag).toMatch(/ autocomplete="off"/iu);
    expect(tag).toContain('data-1p-ignore="true"');
    expect(tag).toContain('data-lpignore="true"');
  });

  it("⚠️ carries no value, ever", () => {
    expect(input(renderToStaticMarkup(<VaultCodeField err={null} />), 'name="code"')).not.toMatch(/ value=/u);
  });
});

describe("a refused add keeps its input (H2)", () => {
  it("reopens with name, note and rank", () => {
    const html = renderToStaticMarkup(<AddLockForm err={null} open kept={{ name: "Gate & Co", note: "by the well", minRole: "officer" }} />);
    expect(html).toMatch(/<details[^>]*open=""/u);
    expect(input(html, 'name="name"')).toContain('value="Gate &amp; Co"');
    expect(input(html, 'name="note"')).toContain('value="by the well"');
    expect(html).toContain('<option value="officer" selected="">');
  });

  /** ⚠️ Review focus 3: a crafted ?kept.code= never reaches the page. */
  it("⚠️ a crafted kept.code never renders", () => {
    const k = readKept({ "kept.code": "1234", "kept.name": "Gate" });
    const html = renderToStaticMarkup(<AddLockForm err={null} open kept={{ name: k.get("name"), note: k.get("note"), minRole: k.get("minRole") }} />);
    expect(k.get("code")).toBeUndefined();
    expect(html).not.toContain("1234");
  });

  /** ⚠️ Review focus 3: the route never lists the code among what it keeps. */
  it("⚠️ the add route keeps name, note and rank — never the code", () => {
    const route = read("app", "api", "vault", "add", "route.ts");
    expect(route).toContain("keepFrom(form, { name: VAULT_NAME_MAX, note: VAULT_NOTE_MAX, minRole: MIN_ROLE_MAX })");
    expect(route).not.toMatch(/keepFrom\([^)]*code/u);
  });

  it("ignores a kept rank that is not a rank", () => {
    expect(renderToStaticMarkup(<AddLockForm err={null} open kept={{ minRole: "admin" }} />)).toContain('<option value="member" selected="">');
  });
});

describe("a refused edit opens its own lock (M11)", () => {
  it("opens that lock's editor with the sentence and the typed values inside it", () => {
    const html = renderToStaticMarkup(<LockEditor lock={LOCK} open error="A lock name is 1 to 40 characters." kept={{ name: "Back gate" }} />);
    expect(html).toMatch(/<details class="group border-t border-rule-2" open="">/u);
    expect(html).toContain("A lock name is 1 to 40 characters.");
    expect(input(html, 'name="name"')).toContain('value="Back gate"');
    expect(input(html, 'name="note"')).toContain('value="north wall"');
  });

  it("stays folded, with the lock's own values, otherwise", () => {
    const html = renderToStaticMarkup(<LockEditor lock={LOCK} open={false} />);
    expect(html).not.toContain('open=""');
    expect(input(html, 'name="name"')).toContain('value="Main gate"');
  });

  it("the edit route names its lock on every refusal", () => {
    expect(read("app", "api", "vault", "edit", "route.ts")).toContain("keep: { lock: String(lockId),");
  });
});
