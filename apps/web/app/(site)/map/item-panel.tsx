import type { ReactNode } from "react";
import { ITEM_COPY } from "@/lib/map-copy";
import type { ItemPanelModel } from "@/lib/item-view";

export type ItemPanelProps = {
  model: ItemPanelModel;
  /** Clear: the map's world switches go back to how they were before the pick (lib/item-view.ts). */
  onClear: () => void;
  /** "panel" is the desktop box under the search; "sheet" is the phone's bottom bar. */
  variant: "panel" | "sheet";
  /** The item's card (picture, display name), above the lines. Task 10 fills it; the panel stands without it. */
  card?: ReactNode;
};

/**
 * The item view's panel: the "Showing where … spawns" chip with Clear, then every way the
 * item reaches players, one labelled line each (lib/item-view.ts itemPanel).
 */
export function ItemPanel({ model, onClear, variant, card }: ItemPanelProps) {
  const sheet = variant === "sheet";
  const pad = sheet ? "px-4" : "px-5";
  return (
    <section aria-label={model.chip} className={sheet ? "border-b border-rule-2" : "w-[300px] border-2 border-rule-2 bg-frame"}>
      <div className={`flex min-h-[44px] items-center gap-3 border-b border-rule-2 ${pad} ${sheet ? "" : "border-l-4 border-l-gold"}`}>
        <p role="status" className="m-0 min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-[0.12em] text-ink">{model.chip}</p>
        <button type="button" onClick={onClear} className="-mr-2 flex min-h-[44px] flex-none items-center px-2 font-mono text-[11px] uppercase tracking-[0.12em] text-gold hover:text-gold-hover">{ITEM_COPY.clear}</button>
      </div>
      {card}
      <dl className={`m-0 ${sheet ? "max-h-[24dvh]" : "max-h-[calc(100dvh-20rem)]"} overflow-y-auto ${pad} py-2`}>
        {model.lines.map((l, i) => (
          <div key={i} className="py-1">
            <dt className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">{l.label}</dt>
            <dd className="m-0 text-sm leading-relaxed text-ink">{l.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
