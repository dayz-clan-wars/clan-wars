import { WORLD_COPY, WORLD_GROUPS, tierLabel } from "@/lib/map-copy";
import { layerIcon, type Palette } from "@/lib/map-icons";
import type { WorldLayer, WorldLayerKey } from "@/lib/world-layers";

export type WorldPanelProps = {
  /** "loading" renders nothing: the clan layers above are the panel until the file lands. */
  status: "loading" | "failed" | "ready";
  layers: WorldLayer[];
  counts: Record<WorldLayerKey, number>;
  on: Record<WorldLayerKey, boolean>;
  onToggle: (key: WorldLayerKey) => void;
  /** Only the tiers the data carries (world-layers.ts presentTiers). */
  tiers: { name: string; bit: number }[];
  tierMask: number;
  onTier: (bit: number) => void;
  pal: Palette;
  /** "panel" is the desktop aside's rows; "sheet" is the phone sheet's chips. */
  variant: "panel" | "sheet";
  /** Refetches the world file after a failed load (loadWorld does not cache a failure). */
  onRetry?: () => void;
};

/**
 * The world layers' section of the layers panel: a heading per group (map-copy.ts
 * WORLD_GROUPS), a switch per layer with its count, and the tier filter under Loot
 * buildings. Below the clan layers on both layouts.
 */
export function WorldPanel({ status, layers, counts, on, onToggle, tiers, tierMask, onTier, pal, variant, onRetry }: WorldPanelProps) {
  if (status === "loading") return null;
  const sheet = variant === "sheet";
  if (status === "failed") {
    return (
      <p className={`m-0 flex flex-wrap items-center gap-x-3 border-t border-rule-2 font-mono text-[11px] text-muted ${sheet ? "px-4 py-2" : "px-5 py-3"}`}>
        {WORLD_COPY.failed}
        {onRetry && <button type="button" onClick={onRetry} className="min-h-[44px] text-gold hover:underline">{WORLD_COPY.retry}</button>}
      </p>
    );
  }
  const heading = `m-0 font-mono text-[11px] uppercase tracking-[0.18em] text-muted ${sheet ? "px-4 pt-3" : "px-5 pt-3"}`;
  const tierRow = tiers.length > 1 && (
    <fieldset className={`m-0 flex flex-wrap items-center gap-2 border-0 p-0 ${sheet ? "px-4 pb-1 pt-2" : "px-5 pb-2 pt-1"}`}>
      <legend className="float-left mr-1 font-mono text-[11px] uppercase tracking-[0.12em] text-muted">{WORLD_COPY.tiers}</legend>
      {tiers.map((t) => {
        const checked = (tierMask & t.bit) !== 0;
        return (
          <label key={t.name} className={`flex min-h-[44px] cursor-pointer items-center border-2 px-2.5 font-mono text-[11px] uppercase tracking-[0.08em] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-gold ${checked ? "border-gold text-ink" : "border-rule-3 text-muted"}`}>
            <input type="checkbox" className="sr-only" checked={checked} onChange={() => onTier(t.bit)} />
            {tierLabel(t.name)}
          </label>
        );
      })}
    </fieldset>
  );
  return (
    <div className="border-t border-rule-2 pb-1.5">
      <p className={`m-0 font-mono text-[11px] leading-relaxed text-muted ${sheet ? "px-4 pt-3" : "px-5 pt-3"}`}>{WORLD_COPY.zoom}</p>
      {WORLD_GROUPS.map((group) => {
        const rows = layers.filter((l) => l.group === group);
        if (rows.length === 0) return null;
        return (
          <section key={group} aria-label={group}>
            <h3 className={heading}>{group}</h3>
            {sheet ? (
              <div className="flex flex-wrap gap-2 px-4 pt-2">
                {rows.map((l) => (
                  <label key={l.key} className={`flex min-h-[44px] cursor-pointer items-center gap-2 border-2 px-3 font-mono text-[11px] uppercase tracking-[0.12em] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-gold ${on[l.key] ? "border-gold text-ink" : "border-rule-3 text-muted"}`}>
                    <input type="checkbox" className="sr-only" checked={on[l.key] ?? false} onChange={() => onToggle(l.key)} />
                    <span aria-hidden="true" className="flex flex-none" dangerouslySetInnerHTML={{ __html: layerIcon(pal, l.key, 16) }} />
                    {l.label}
                    <span className="text-muted">{counts[l.key] ?? 0}</span>
                  </label>
                ))}
              </div>
            ) : (
              <ul className="m-0 list-none p-0">
                {rows.map((l) => (
                  <li key={l.key}>
                    <label className="flex min-h-[44px] cursor-pointer items-center gap-3 px-5 text-sm text-ink">
                      <input type="checkbox" className="h-4 w-4 flex-none accent-gold" checked={on[l.key] ?? false} onChange={() => onToggle(l.key)} />
                      <span aria-hidden="true" className={`flex flex-none ${on[l.key] ? "" : "opacity-40"}`} dangerouslySetInnerHTML={{ __html: layerIcon(pal, l.key) }} />
                      {l.label}
                      <span className="ml-auto font-mono text-[11px] text-muted">{counts[l.key] ?? 0}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {group === "Loot buildings" && tierRow}
          </section>
        );
      })}
    </div>
  );
}
