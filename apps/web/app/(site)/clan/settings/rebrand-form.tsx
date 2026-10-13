import { flagLabel } from "@factions/copy";
import { CLAN_NAME_LENGTH, CLAN_TAG_LENGTH } from "@factions/domain";
import type { FieldError as FieldErrorT } from "@/lib/field-errors";
import { when } from "@/lib/format";
import { FlagPicker } from "@/app/components/flag-picker";
import { FieldError, SubmitButton, invalid, btnSecondary, field, fieldLabel } from "@/app/components/ui";

/**
 * The leader's rebrand form: name, tag and flag. While a flag change waits
 * for its first raise it shows that instead, with Cancel.
 *
 * H2: a refused rename comes back with what was typed. Before, the fields
 * reset to the clan's current name, so "Another clan has that name." sat
 * under the name the clan already has — the one name it was plainly not about.
 */
export function RebrandForm({ name, tag, texture, freeFlags, pending, err, kept }: {
  name: string; tag: string; texture: string; freeFlags: string[];
  pending: { texture: string; until: Date } | null;
  err: FieldErrorT | null; kept: { name?: string; tag?: string; texture?: string };
}) {
  if (pending) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm leading-relaxed text-ink-2">
          <strong>{flagLabel(pending.texture)}</strong> is reserved for you. It arrives in your kit at the next restart. Raise it at your pole by {when(pending.until)} to make it yours. Until then you still fly {flagLabel(texture)}.
        </p>
        <form action="/api/clan/rebrand/cancel" method="post">
          <SubmitButton className={`${btnSecondary} self-start`} pending="Cancelling…">Cancel flag change</SubmitButton>
        </form>
      </div>
    );
  }
  return (
    <form className="flex flex-col gap-3" action="/api/clan/rename" method="post">
      <label className="block"><span className={fieldLabel}>Name</span><input {...invalid(err, "name")} className={`${field} ${invalid(err, "name").className ?? ""}`} name="name" defaultValue={kept.name ?? name} required minLength={CLAN_NAME_LENGTH.min} maxLength={CLAN_NAME_LENGTH.max} /><FieldError err={err} name="name" /></label>
      <label className="block"><span className={fieldLabel}>Tag</span><input name="tag" defaultValue={kept.tag ?? tag} minLength={CLAN_TAG_LENGTH.min} maxLength={CLAN_TAG_LENGTH.max} pattern="[A-Za-z0-9]+" title={`${CLAN_TAG_LENGTH.min} to ${CLAN_TAG_LENGTH.max} letters or digits`} {...invalid(err, "tag")} className={`${field} uppercase ${invalid(err, "tag").className ?? ""}`} aria-describedby={err?.field === "tag" ? "err-tag rename-note" : "rename-note"} /><FieldError err={err} name="tag" /></label>
      <FlagPicker flags={freeFlags} name="texture" keep={{ texture, label: flagLabel(texture) }} checked={kept.texture} err={err} />
      <p id="rename-note" className="text-xs text-muted">The old name and tag stay held, so nobody else can take them. A new flag is yours once a member raises it at your pole.</p>
      <SubmitButton className={`${btnSecondary} self-start`}>Rebrand</SubmitButton>
    </form>
  );
}
