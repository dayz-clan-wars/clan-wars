import { ACTIVATION_WINDOW_MS, CLAN_NAME_LENGTH, CLAN_SIZE_CAP, CLAN_TAG_LENGTH, MIN_BASE_SPACING_M } from "@factions/domain";
import { days } from "@/lib/format";
import { flagThumbPath } from "@/src/flag-images";
import type { FieldError as FieldErrorT } from "@/lib/field-errors";
import { Panel, PanelBody, FieldError, SubmitButton, invalid, btnCta, field, fieldLabel, checkbox, kickerSm } from "@/app/components/ui";

/** What a refused claim sent back (lib/form.ts readKept). */
export type ClaimKept = { name?: string; tag?: string; texture?: string; members: string[] };

/**
 * The four panels of /claim/{ceremony}: name and tag, flag, roster, and the
 * button.
 *
 * H2: a refusal ("name taken") used to cost the founder all four panels,
 * and brought unticked founders back ticked. Every field now comes back as
 * it was sent.
 *
 * H3: a flag or roster refusal focuses the first control of that group, which
 * is described by the sentence, so it is announced where it is fixed.
 */
export function ClaimForm({ ceremonyId, freeFlags, participants, meDayzId, err, kept }: {
  ceremonyId: number; freeFlags: string[]; participants: { dayzId: string; gamertag: string }[]; meDayzId: string | null; err: FieldErrorT | null; kept: ClaimKept;
}) {
  // ⚠️ A kept flag is re-picked only while it is still free: "flag-taken" means
  // someone else holds it now, and re-checking it would re-send a refusal.
  const keptFlag = kept.texture !== undefined && freeFlags.includes(kept.texture) ? kept.texture : undefined;
  // ⚠️ Empty means "nothing to restore", not "nobody ticked": the claimant's own
  // hidden field always posts, so a refused roster that came back is never empty.
  const keptMembers = kept.members.length > 0 ? new Set(kept.members) : null;
  const flagErr = err?.field === "texture";
  const memberErr = err?.field === "member";
  const firstOther = participants.find((p) => p.dayzId !== meDayzId)?.dayzId;

  return (
    <form className="flex flex-col gap-4 lg:gap-6" action="/api/claim" method="post">
      <input type="hidden" name="ceremonyId" value={ceremonyId} />

      <Panel num="01" title="Name and tag">
        <PanelBody className="flex flex-col gap-3">
          <label className="block"><span className={fieldLabel}>Name</span>
            <input {...invalid(err, "name")} className={`${field} ${invalid(err, "name").className ?? ""}`} name="name" defaultValue={kept.name} required minLength={CLAN_NAME_LENGTH.min} maxLength={CLAN_NAME_LENGTH.max} autoComplete="off" />
            <FieldError err={err} name="name" />
          </label>
          <label className="block"><span className={fieldLabel}>Tag — {CLAN_TAG_LENGTH.min} to {CLAN_TAG_LENGTH.max} letters or digits</span>
            <input {...invalid(err, "tag")} className={`${field} uppercase ${invalid(err, "tag").className ?? ""}`} name="tag" defaultValue={kept.tag} required minLength={CLAN_TAG_LENGTH.min} maxLength={CLAN_TAG_LENGTH.max} pattern="[A-Za-z0-9]+" title={`${CLAN_TAG_LENGTH.min} to ${CLAN_TAG_LENGTH.max} letters or digits`} autoComplete="off" />
            <FieldError err={err} name="tag" />
          </label>
        </PanelBody>
      </Panel>

      {/*
       * Controller ruling (2026-09-24): --color-rust means an outstanding
       * obligation only (a pending/expired challenge), never a refusal — so
       * this panel's `tone` stays "plain" even on a flag refusal. The
       * focused FieldError below still names the problem.
       */}
      <Panel num="02" title="Flag" aside={`${freeFlags.length} free`} tone="plain">
        <PanelBody>
          <fieldset aria-describedby={flagErr ? "err-texture" : undefined}>
            <legend className="sr-only">Flag</legend>
            <FieldError err={err} name="texture" />
            <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {freeFlags.map((f, i) => (
                <li key={f}>
                  <label className="group relative flex cursor-pointer flex-col items-center gap-1 border-2 border-rule-3 p-2 has-[:checked]:border-gold has-[:checked]:bg-surface has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-gold">
                    <input type="radio" name="texture" value={f} required className="sr-only" defaultChecked={f === keptFlag}
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
        </PanelBody>
      </Panel>

      {/* Controller ruling: same as the flag panel above — plain, never rust, on a roster refusal. */}
      <Panel num="03" title="Roster" aside={`at most ${CLAN_SIZE_CAP}`} tone="plain">
        <PanelBody>
          <fieldset aria-describedby={memberErr ? "err-member" : undefined}>
            {/* L4: the legend must be the fieldset's first child, or it is not its name. */}
            <legend className="text-sm leading-relaxed text-ink-2">Untick anyone who should not be in. Only people at the ceremony can be founding members.</legend>
            <FieldError err={err} name="member" />
            <ul className="mt-2 flex flex-col">
              {participants.map((p) => {
                const self = p.dayzId === meDayzId;
                return (
                  <li key={p.dayzId}>
                    <label className="flex min-h-[44px] items-center gap-3 text-ink">
                      <input type="checkbox" name="member" value={p.dayzId} disabled={self} className={checkbox}
                        defaultChecked={self || (keptMembers ? keptMembers.has(p.dayzId) : true)}
                        aria-invalid={memberErr || undefined} autoFocus={memberErr && p.dayzId === firstOther ? true : undefined} />
                      <span className="font-mono">{p.gamertag}</span>
                      {self && <span className={`${kickerSm} !text-gold`}>you — leader</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
            {/* A disabled checkbox does not post; the claimant must be on the roster, so carry them explicitly. */}
            {meDayzId && <input type="hidden" name="member" value={meDayzId} />}
          </fieldset>
        </PanelBody>
      </Panel>

      <p className="text-sm leading-relaxed text-ink-2">Claiming reserves the name, tag, flag and pole. Raise your flag at the pole within {days(ACTIVATION_WINDOW_MS)} to activate. No two bases sit within {MIN_BASE_SPACING_M} m of each other — if the pole is too close to one you cannot see, the claim is refused.</p>
      <SubmitButton className={btnCta} pending={<>Founding… <span className="font-mono normal-case">→</span></>}>Found the clan <span className="font-mono normal-case">→</span></SubmitButton>
    </form>
  );
}
