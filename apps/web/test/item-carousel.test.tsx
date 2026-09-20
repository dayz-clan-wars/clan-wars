import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ItemCarousel } from "../app/(site)/kit/item-carousel";

const OPTIONS = [
  { className: "GasMask", label: "Gas Mask", image: "items/GasMask.webp" },
  { className: "NoArt", label: "No Art Yet" },
];

/**
 * ⚠️ The <input> tag alone, never a slice of the surrounding markup: every
 * tile's class list contains `has-[:checked]`, so a substring search over a
 * character window matches "checked" on tiles that are not checked. Two
 * earlier assertions passed unconditionally for exactly that reason.
 */
const inputFor = (html: string, value: string): string =>
  html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`, "u"))?.[0] ?? "";

describe("ItemCarousel", () => {
  it("renders one radio per option, plus the empty one", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current={null} />);
    expect(html.match(/type="radio"/gu) ?? []).toHaveLength(3);
    expect(html).toContain('value="GasMask"');
    expect(html).toContain('value=""');
  });

  it("submits under the name the server action reads", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current={null} />);
    expect(html).toContain('name="className"');
  });

  it("marks the saved pick as checked, and nothing else", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current="GasMask" />);
    expect(inputFor(html, "GasMask")).toContain("checked");
    expect(inputFor(html, "")).not.toContain("checked");
    expect(inputFor(html, "NoArt")).not.toContain("checked");
  });

  it("checks the empty option when nothing is saved", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current={null} />);
    expect(inputFor(html, "")).toContain("checked");
    expect(inputFor(html, "GasMask")).not.toContain("checked");
  });

  // ⚠️ Coverage gaps are expected and must look deliberate, not broken.
  it("renders an item with no image as a labelled tile, still selectable", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current={null} />);
    expect(html).toContain('value="NoArt"');
    expect(html).toContain("No Art Yet");
  });

  it("is a radiogroup, so arrow keys move between tiles", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current={null} />);
    expect(html).toContain('role="radiogroup"');
  });

  /**
   * ⚠️ `sr-only` is `position: absolute`. On a static label the hidden radios
   * resolve against the BODY instead of their own tile, which stretched the
   * page's scroll width by 4870px on production and made a click near the end
   * of a strip scroll the whole page sideways into empty space. Nothing threw
   * and no rendered-markup assertion could see it, so this pins the one class
   * that prevents it.
   */
  it("keeps every tile positioned, so the hidden radio cannot escape it", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current={null} />);
    const labels = html.match(/<label[^>]*>/gu) ?? [];
    expect(labels).not.toHaveLength(0);
    for (const l of labels) expect(l).toMatch(/\brelative\b/u);
  });
});
