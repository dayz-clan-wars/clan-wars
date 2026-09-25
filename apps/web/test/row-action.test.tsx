import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RowAction } from "../app/components/row-action";
import { GuestPassList } from "../app/(site)/clan/settings/guest-passes";

describe("RowAction (M3)", () => {
  it("names who it acts on inside the button, for a screen reader's button list", () => {
    const html = renderToStaticMarkup(<RowAction action="/api/clan/promote" fields={{ target: "d1" }} who="Ada">Make officer</RowAction>);
    expect(html).toContain('Make officer<span class="sr-only"> Ada</span>');
    expect(html).toContain('action="/api/clan/promote"');
    expect(html).toContain('<input type="hidden" name="target" value="d1"/>');
  });

  it("carries every hidden field", () => {
    const html = renderToStaticMarkup(<RowAction action="/api/clan/decide-request" fields={{ requestId: 7, decision: "accepted" }} who="Bo">Accept</RowAction>);
    expect(html).toContain('name="requestId" value="7"');
    expect(html).toContain('name="decision" value="accepted"');
  });

  it("names the target on a two-press button too", () => {
    const html = renderToStaticMarkup(<RowAction action="/api/clan/kick" fields={{ target: "d1" }} who="Ada" confirm="Press again to remove">Remove</RowAction>);
    expect(html).toContain('Remove<span class="sr-only"> Ada</span>');
  });

  it("the guest pass Revoke says whose pass", () => {
    const html = renderToStaticMarkup(<GuestPassList passes={[{ id: 1, userDiscordId: "1", userGamertag: "Gus", grantedBy: "Otto", expiresAt: new Date() }]} />);
    expect(html).toContain('Revoke<span class="sr-only"> Gus</span>');
  });
});
