"use client";

import s from "./mobile.module.css";

/**
 * ⚠️ Back returns to the TAB the pushed screen was opened from, not to the last
 * screen rendered. Owning that decision in one component keeps the three pushed
 * screens from each inventing their own answer.
 */
export function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className={`${s.tap} ${s.tapFade} ${s.back} ${s.mono}`} onClick={onBack}>
      <span style={{ fontSize: 13 }}>←</span>
      <span>Back</span>
    </button>
  );
}
