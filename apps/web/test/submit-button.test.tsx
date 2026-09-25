import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { guardFormSubmit } from "../lib/submit-guard";
import { SubmitButton } from "../app/components/ui";

/** Dispatches a cancelable submit; true means the form would post. */
const submit = (form: EventTarget) => form.dispatchEvent(new Event("submit", { cancelable: true }));
const pageshow = (win: EventTarget, persisted: boolean) => win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));

describe("guardFormSubmit", () => {
  it("lets the first submit through and cancels every one after it", () => {
    const form = new EventTarget(); const win = new EventTarget(); const seen: boolean[] = [];
    guardFormSubmit(form, win, (p) => seen.push(p));
    expect(submit(form)).toBe(true);
    expect(submit(form)).toBe(false);
    expect(submit(form)).toBe(false);
    expect(seen).toEqual([true]);
  });

  /**
   * ⚠️ Review focus 4. Back from the next page restores this one from the
   * bfcache with its JS state intact: without the reset the button is dead.
   */
  it("⚠️ re-opens when the page comes back from the back/forward cache", () => {
    const form = new EventTarget(); const win = new EventTarget(); const seen: boolean[] = [];
    guardFormSubmit(form, win, (p) => seen.push(p));
    submit(form);
    pageshow(win, true);
    expect(seen).toEqual([true, false]);
    expect(submit(form)).toBe(true);
  });

  it("ignores a pageshow that is a fresh load", () => {
    const form = new EventTarget(); const win = new EventTarget();
    guardFormSubmit(form, win, () => {});
    submit(form);
    pageshow(win, false);
    expect(submit(form)).toBe(false);
  });

  it("leaves alone a submit another handler already cancelled", () => {
    const form = new EventTarget(); const win = new EventTarget(); const seen: boolean[] = [];
    form.addEventListener("submit", (e) => e.preventDefault());
    guardFormSubmit(form, win, (p) => seen.push(p));
    submit(form);
    expect(seen).toEqual([]);
  });

  it("stops guarding once disposed", () => {
    const form = new EventTarget(); const win = new EventTarget();
    const dispose = guardFormSubmit(form, win, () => {});
    submit(form);
    dispose();
    expect(submit(form)).toBe(true);
  });
});

describe("SubmitButton", () => {
  /** ⚠️ Review focus 4: with JavaScript off this is the whole button, so it must post. */
  it("⚠️ server-renders as a plain, enabled submit button", () => {
    const html = renderToStaticMarkup(<form action="/api/x" method="post"><SubmitButton className="btn">Found the clan</SubmitButton></form>);
    expect(html).toContain('<button type="submit" class="btn');
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("aria-busy");
    expect(html).toContain("Found the clan");
  });

  it("passes a real disabled through", () => {
    const html = renderToStaticMarkup(<SubmitButton className="btn" disabled>Declare</SubmitButton>);
    expect(html).toContain('disabled=""');
  });
});
