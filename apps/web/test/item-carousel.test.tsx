import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ItemCarousel } from "../app/(site)/kit/item-carousel";

const OPTIONS = [
  { className: "GasMask", label: "Gas Mask", image: "items/GasMask.webp" },
  { className: "NoArt", label: "No Art Yet" },
];

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

  it("marks the saved pick as checked", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current="GasMask" />);
    const tile = html.slice(html.indexOf('value="GasMask"'));
    expect(tile.slice(0, 200)).toContain("checked");
  });

  it("checks the empty option when nothing is saved", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current={null} />);
    const empty = html.slice(html.indexOf('value=""'));
    expect(empty.slice(0, 200)).toContain("checked");
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
});
