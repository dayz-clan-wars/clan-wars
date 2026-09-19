import type { CatalogueEntry, KitSlot } from "@factions/domain";

/**
 * One slot's options as a horizontally scrolling strip of image tiles.
 *
 * ⚠️ Radio inputs, not buttons, and no client JavaScript: the form still posts
 * `className` exactly as the <select> it replaces did, so the slot save works
 * with JS off — the same bar every other write on this site clears. Native
 * overflow scroll plus CSS scroll-snap does the carousel; no library.
 *
 * ⚠️ `role="radiogroup"` plus real radios is what gives arrow-key movement for
 * free. Styling them as tiles must not cost that: the input stays in the DOM,
 * visually hidden, never `display: none`.
 */
export function ItemCarousel({ slot, options, current }: {
  slot: KitSlot;
  options: readonly CatalogueEntry[];
  current: string | null;
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={`slot-${slot}-label`}
      className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-2 lg:-mx-5 lg:px-5"
    >
      <Tile slot={slot} value="" label="Nothing" image={undefined} checked={current === null || current === ""} />
      {options.map((o) => (
        <Tile
          key={o.className}
          slot={slot}
          value={o.className}
          label={o.label}
          image={o.image}
          checked={current === o.className}
        />
      ))}
    </div>
  );
}

function Tile({ slot, value, label, image, checked }: {
  slot: KitSlot;
  value: string;
  label: string;
  image: string | undefined;
  checked: boolean;
}) {
  const id = `slot-${slot}-${value || "none"}`;
  return (
    <label
      htmlFor={id}
      className="group flex w-24 flex-none snap-start cursor-pointer flex-col items-center gap-1 rounded-sm border border-rule-2 p-2 text-center has-[:checked]:border-ink has-[:checked]:bg-paper-2 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2"
    >
      {checked ? (
        <input
          type="radio"
          id={id}
          name="className"
          value={value}
          checked
          readOnly
          className="sr-only"
        />
      ) : (
        <input
          type="radio"
          id={id}
          name="className"
          value={value}
          readOnly
          className="sr-only"
        />
      )}
      {image ? (
        <img src={`/${image}`} alt="" width={64} height={64} className="h-16 w-16 flex-none object-contain" />
      ) : (
        <span className="flex h-16 w-16 flex-none items-center justify-center rounded-sm border border-dashed text-ink-2">
          {value ? "No art" : "None"}
        </span>
      )}
      <span className="text-xs leading-tight text-ink-2 group-has-[:checked]:text-ink">{label}</span>
    </label>
  );
}
