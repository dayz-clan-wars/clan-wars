import s from "../auth.module.css";

/**
 * One refusal notice.
 *
 * ⚠️ The design's "someone else is verifying" panel ended with the sentence
 * `Not "try again in a moment" — that would be a lie for up to a full day.`
 * That is rationale addressed to whoever builds this, NOT copy addressed to a
 * player, and it is not rendered anywhere. It survives as this comment, and as
 * the reason `contestedFor` names a real duration instead of saying "shortly".
 */
export function Refusal({
  label,
  neutral = false,
  children,
}: {
  label: string;
  /** A switch is something that happened, not something denied — see the CSS. */
  neutral?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={s.refusal} role="status">
      <div className={`${s.refusalLabel} ${neutral ? s.refusalLabelNeutral : ""} ${s.mono}`}>
        {label}
      </div>
      <div className={s.refusalBody}>{children}</div>
    </div>
  );
}
