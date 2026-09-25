import { CLAN_NAME_LENGTH, CLAN_TAG_LENGTH } from "@factions/domain";
import type { FieldError as FieldErrorT } from "@/lib/field-errors";
import { FieldError, SubmitButton, invalid, btnSecondary, field, fieldLabel } from "@/app/components/ui";

/**
 * The leader's rename form.
 *
 * H2: a refused rename comes back with what was typed. Before, the fields
 * reset to the clan's current name, so "Another clan has that name." sat
 * under the name the clan already has — the one name it was plainly not about.
 */
export function RenameForm({ name, tag, err, kept }: { name: string; tag: string; err: FieldErrorT | null; kept: { name?: string; tag?: string } }) {
  return (
    <form className="flex flex-col gap-3" action="/api/clan/rename" method="post">
      <label className="block"><span className={fieldLabel}>Name</span><input {...invalid(err, "name")} className={`${field} ${invalid(err, "name").className ?? ""}`} name="name" defaultValue={kept.name ?? name} required minLength={CLAN_NAME_LENGTH.min} maxLength={CLAN_NAME_LENGTH.max} /><FieldError err={err} name="name" /></label>
      <label className="block"><span className={fieldLabel}>Tag</span><input name="tag" defaultValue={kept.tag ?? tag} minLength={CLAN_TAG_LENGTH.min} maxLength={CLAN_TAG_LENGTH.max} pattern="[A-Za-z0-9]+" title={`${CLAN_TAG_LENGTH.min} to ${CLAN_TAG_LENGTH.max} letters or digits`} {...invalid(err, "tag")} className={`${field} uppercase ${invalid(err, "tag").className ?? ""}`} aria-describedby={err?.field === "tag" ? "err-tag rename-note" : "rename-note"} /><FieldError err={err} name="tag" /></label>
      <p id="rename-note" className="text-xs text-muted">The old name and tag stay held — nobody else can take them.</p>
      <SubmitButton className={`${btnSecondary} self-start`}>Rename</SubmitButton>
    </form>
  );
}
