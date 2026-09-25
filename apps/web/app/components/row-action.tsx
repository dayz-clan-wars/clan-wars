import { ConfirmButton, SubmitButton, btnSecondary } from "./ui";

/**
 * Hidden fields + one button: the shape of every per-row action on the clan
 * pages and /base.
 *
 * ⚠️ M3: `who` rides inside the button as screen-reader-only text. Ten
 * "Remove" buttons are ten identical entries in a screen reader's list of
 * buttons; "Remove Ada" is one decision. The visible text stays the short
 * verb because the row already shows the name.
 */
export function RowAction({ action, fields, who, children, style = btnSecondary, confirm, disabled = false }: {
  action: string; fields: Record<string, string | number>; who: string; children: React.ReactNode; style?: string; confirm?: string; disabled?: boolean;
}) {
  const label = <>{children}<span className="sr-only">{` ${who}`}</span></>;
  return (
    <form action={action} method="post">
      {Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      {confirm
        ? <ConfirmButton confirm={confirm} className={`${style} !px-3.5`} disabled={disabled}>{label}</ConfirmButton>
        : <SubmitButton className={`${style} !px-3.5`} disabled={disabled}>{label}</SubmitButton>}
    </form>
  );
}
