import { VAULT_CODE_DIGITS, VAULT_NAME_MAX, VAULT_NOTE_MAX } from "@factions/domain";
import type { FieldError as FieldErrorT } from "@/lib/field-errors";
import { VAULT_ROLES, roleOr } from "@/lib/vault-form";
import { ConfirmButton, FieldError, Notice, SubmitButton, invalid, btnDanger, btnPrimary, btnSecondary, field, fieldLabel } from "@/app/components/ui";

/** What a refused add or edit sent back (lib/form.ts readKept). ⚠️ Never a code: readKept cannot return one. */
export type KeptLock = { name?: string; note?: string; minRole?: string };

const CODE_PATTERN = `\\d{${VAULT_CODE_DIGITS}}`;
/** A fold's head: the mono caption with a chevron, 48px, full width. */
export const fold = "flex min-h-[48px] cursor-pointer list-none items-center justify-between gap-3 px-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-ink [&::-webkit-details-marker]:hidden";
export const Chevron = () => <><span aria-hidden="true" className="group-open:hidden">▾</span><span aria-hidden="true" className="hidden group-open:inline">▴</span></>;

/**
 * The one field a player types a vault code into.
 *
 * ⚠️ M10: autocomplete off, and the two password-manager opt-outs. The vault
 * hides codes behind a tap so a stream catches nothing; a browser that saved
 * this field would offer the last code in a dropdown the moment it takes
 * focus — on stream. It takes no value prop at all: nothing ever refills it.
 */
export function VaultCodeField({ err }: { err: FieldErrorT | null }) {
  return (
    <label className="block"><span className={fieldLabel}>Code</span>
      <input {...invalid(err, "code")} className={`${field} ${invalid(err, "code").className ?? ""}`} name="code" pattern={CODE_PATTERN} inputMode="numeric"
        title={`${VAULT_CODE_DIGITS} digits`} aria-describedby={err?.field === "code" ? "err-code code-note" : "code-note"}
        autoComplete="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" />
      <FieldError err={err} name="code" />
    </label>
  );
}

/** "+ Add lock". H2: a refused add reopens with name, note and rank as typed — never the code. */
export function AddLockForm({ err, kept, open }: { err: FieldErrorT | null; kept: KeptLock; open: boolean }) {
  return (
    <details className="group border-2 border-rule-2 bg-frame sm:col-span-2" open={open}>
      <summary className={`${fold} !text-ink`}>+ Add lock <Chevron /></summary>
      <form className="flex flex-col gap-3 border-t-2 border-rule-2 p-4 lg:p-5" action="/api/vault/add" method="post">
        <label className="block"><span className={fieldLabel}>Name</span><input {...invalid(err, "name")} className={`${field} ${invalid(err, "name").className ?? ""}`} name="name" defaultValue={kept.name} required maxLength={VAULT_NAME_MAX} /><FieldError err={err} name="name" /></label>
        <label className="block"><span className={fieldLabel}>Note</span><input {...invalid(err, "note")} className={`${field} ${invalid(err, "note").className ?? ""}`} name="note" defaultValue={kept.note} maxLength={VAULT_NOTE_MAX} /><FieldError err={err} name="note" /></label>
        <label className="block"><span className={fieldLabel}>Minimum rank</span>
          <select className={field} name="minRole" defaultValue={roleOr(kept.minRole, "member")} required>
            {VAULT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <VaultCodeField err={err} />
        <p id="code-note" className="-mt-1 text-xs text-muted">{VAULT_CODE_DIGITS} digits. Leave it blank and one is generated.</p>
        <SubmitButton className={`${btnPrimary} self-start`}>Add lock</SubmitButton>
      </form>
    </details>
  );
}

/**
 * One lock's folded "Edit": rename / re-note / re-gate, Rotate, Delete.
 *
 * M11: a refused edit reopens THIS lock's fold with the sentence inside it
 * and the values as typed. Before, the refusal went to the notice at the top
 * of the page and the lock came back folded and reverted, so the officer had
 * to find which lock it was about and retype it.
 */
export function LockEditor({ lock, open, error, err, kept }: {
  lock: { id: number; name: string; note: string | null; minRole: string }; open: boolean; error?: string;
  /**
   * ⚠️ F5: the same field-level error `AddLockForm` gets, so `invalid()`/
   * `FieldError` can mark the offending input rather than only saying so in
   * the sentence above it — a screen reader on a plain `<input>` never
   * connects it to that sentence. `error` still carries the WHOLE-editor
   * outcomes `err` has no field for ("gone", "not-permitted"): a Notice with
   * no matching field is the fallback, never a second copy of a field's own
   * message.
   */
  err?: FieldErrorT | null; kept?: KeptLock;
}) {
  return (
    <details className="group border-t border-rule-2" open={open}>
      <summary className={fold}>Edit <Chevron /></summary>
      <div className="flex flex-col gap-4 border-t-2 border-rule-2 bg-surface p-4 lg:p-5">
        {error && !err && <Notice>{error}</Notice>}
        <form className="flex flex-col gap-3" action="/api/vault/edit" method="post">
          <input type="hidden" name="lockId" value={lock.id} />
          <label className="block"><span className={fieldLabel}>Name</span><input {...invalid(err ?? null, "name")} className={`${field} ${invalid(err ?? null, "name").className ?? ""}`} name="name" defaultValue={kept?.name ?? lock.name} required maxLength={VAULT_NAME_MAX} /><FieldError err={err ?? null} name="name" /></label>
          <label className="block"><span className={fieldLabel}>Note</span><input {...invalid(err ?? null, "note")} className={`${field} ${invalid(err ?? null, "note").className ?? ""}`} name="note" defaultValue={kept?.note ?? lock.note ?? ""} maxLength={VAULT_NOTE_MAX} /><FieldError err={err ?? null} name="note" /></label>
          <label className="block"><span className={fieldLabel}>Minimum rank</span>
            <select className={field} name="minRole" defaultValue={roleOr(kept?.minRole, lock.minRole)} required>
              {VAULT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <SubmitButton className={`${btnSecondary} self-start`}>Save</SubmitButton>
        </form>
        <div className="grid grid-cols-2 gap-2 border-t border-rule-2 pt-4">
          <form action="/api/vault/rotate" method="post" className="contents">
            <input type="hidden" name="lockId" value={lock.id} />
            <input type="hidden" name="confirm" value="yes" />
            <ConfirmButton confirm="Press again to rotate" className={`${btnSecondary} w-full`}>Rotate code</ConfirmButton>
          </form>
          <form action="/api/vault/delete" method="post" className="contents">
            <input type="hidden" name="lockId" value={lock.id} />
            <input type="hidden" name="confirm" value="yes" />
            <ConfirmButton confirm="Press again to delete" className={`${btnDanger} w-full`}>Delete</ConfirmButton>
          </form>
        </div>
        <p className="m-0 font-mono text-[11px] leading-relaxed text-muted">Rotate and Delete are two-press: the first tap arms, the second within 4 s does it. Rotating here does not change the lock in the game.</p>
      </div>
    </details>
  );
}
