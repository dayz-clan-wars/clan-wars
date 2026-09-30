import { describe, it, expect } from "vitest";
import { awardsCatalogue } from "@factions/domain/awards";
import { PART_LABELS, comesWith } from "@/lib/award-parts";

describe("award parts", () => {
  // ⚠️ No fallback to the class name on the page: an unlabelled part fails here.
  it("every extra in the catalogue has a readable label", () => {
    const extras = Object.values(awardsCatalogue())
      .flatMap((a) => Object.values(a.slots).flatMap((s) => s.items.flatMap((i) => i.extras ?? [])));
    expect(extras.filter((c) => !PART_LABELS[c])).toEqual([]);
  });

  it("collapses repeats into a count, in first-seen order", () => {
    expect(comesWith(["KobraOptic", "Battery9V", "Mag_AKM_Drum75Rnd", "Mag_AKM_Drum75Rnd"]))
      .toBe("Kobra sight, 9V battery, 2× 75-round AKM drum");
  });
});
