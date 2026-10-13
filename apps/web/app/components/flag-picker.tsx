import { flagThumbPath } from "@/src/flag-images";
import type { FieldError as FieldErrorT } from "@/lib/field-errors";
import { FieldError } from "@/app/components/ui";

const TILE = "group relative flex cursor-pointer flex-col items-center gap-1 border-2 border-rule-3 p-2 has-[:checked]:border-gold has-[:checked]:bg-surface has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-gold";

/**
 * The flag grid, shared by the claim form and the Rebrand panel.
 *
 * `keep` adds one first tile, value "", for "stay as we are"; it is the
 * default pick when `checked` is undefined. `required` is the claim form's
 * (a founder must pick); the Rebrand panel never needs it, since keeping is
 * a pick.
 */
export function FlagPicker({ flags, name, keep, checked, err, required }: {
  flags: string[]; name: string; keep?: { texture: string; label: string }; checked?: string; err: FieldErrorT | null; required?: boolean;
}) {
  const flagErr = err?.field === "texture";
  return (
    <fieldset aria-describedby={flagErr ? "err-texture" : undefined}>
      <legend className="sr-only">Flag</legend>
      <FieldError err={err} name="texture" />
      <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {keep && (
          <li>
            <label className={TILE}>
              <input type="radio" name={name} value="" className="sr-only" defaultChecked={checked === undefined} />
              <span aria-hidden="true" className="absolute right-1 top-1 hidden h-4 w-4 items-center justify-center bg-gold font-mono text-[11px] leading-none text-ground group-has-[:checked]:flex">✓</span>
              <img src={`/${flagThumbPath(keep.texture)}`} alt="" loading="lazy" width={48} height={48} className="h-12 w-12 object-contain" />
              <span className="font-mono text-[11px] text-muted">Keep {keep.label}</span>
            </label>
          </li>
        )}
        {flags.map((f, i) => (
          <li key={f}>
            <label className={TILE}>
              <input type="radio" name={name} value={f} required={required} className="sr-only" defaultChecked={f === checked}
                aria-invalid={flagErr || undefined} autoFocus={flagErr && i === 0 ? true : undefined} />
              {/* L4: the pick is marked by a glyph as well as the edge colour, so it never rests on colour alone. */}
              <span aria-hidden="true" className="absolute right-1 top-1 hidden h-4 w-4 items-center justify-center bg-gold font-mono text-[11px] leading-none text-ground group-has-[:checked]:flex">✓</span>
              {/* L4: alt="" — the flag's name is the text right under it; alt={f} made a reader say it twice. */}
              {/* H5: up to 33 tiles at once — the 96px thumb, not the ~50KB full PNG, covers this 48px box at 2x; lazy because most sit off the fold. */}
              <img src={`/${flagThumbPath(f)}`} alt="" loading="lazy" width={48} height={48} className="h-12 w-12 object-contain" />
              <span className="font-mono text-[11px] text-muted">{f.replace(/^Flag_/u, "")}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
