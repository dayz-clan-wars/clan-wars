import type { ReactNode } from "react";
import { ITEM_COPY } from "@/lib/map-copy";
import type { ItemCardModel, ItemPanelModel } from "@/lib/item-view";

export type ItemPanelProps = {
  model: ItemPanelModel;
  /** Clear: the map's world switches go back to how they were before the pick (lib/item-view.ts). */
  onClear: () => void;
  /** "panel" is the desktop box under the search; "sheet" is the phone's bottom bar. */
  variant: "panel" | "sheet";
  /** The item's card head (ItemCardView), above the lines. Optional: the panel stands without it. */
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

/**
 * The head of an item's card: its picture, the game's name for it, weight and size, and the
 * game's description. Its lists go in the panel's own lines (lib/item-view.ts withCard).
 */
export function ItemCardView({ model, variant }: { model: ItemCardModel; variant: "panel" | "sheet" }) {
  const sheet = variant === "sheet";
  const pad = sheet ? "px-4" : "px-5";
  const edge = sheet ? 56 : 72;
  return (
    <div className={`border-b border-rule-2 ${pad} py-3`}>
      <div className="flex items-start gap-3">
        {model.image && (
          // alt="": the name is the next thing read, right beside it. A plain img: a fixed-size static thumbnail.
          <img src={model.image} alt="" width={edge} height={edge} loading="lazy" className="flex-none bg-surface object-contain" style={{ width: edge, height: edge }} />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="m-0 font-display text-sm uppercase tracking-[0.06em] text-ink">{model.title}</h3>
          {model.facts.length > 0 && (
            <p className="m-0 mt-1 font-mono text-[11px] text-muted">
              {model.facts.map((f) => `${f.label} ${f.text}`).join(" · ")}
            </p>
          )}
        </div>
      </div>
      {/* Clamped on a phone: the sheet is short, and the lines under it are what the player came for. */}
      {model.description && <p className={`m-0 mt-2 text-sm leading-relaxed text-ink ${sheet ? "line-clamp-3" : ""}`}>{model.description}</p>}
    </div>
  );
}
