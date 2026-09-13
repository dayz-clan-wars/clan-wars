import { DECLARE_COPY, DECLARED_OK, RELEASE_COPY, days } from "@factions/copy";

export { DECLARE_COPY, lapsedCopy, days } from "@factions/copy";

/** Every code the two /base route handlers can redirect with. Site-only: the codes are query-string values. */
export const RESULT_COPY: Record<string, string> = {
  declared: DECLARED_OK,
  ...RELEASE_COPY,
  unconfirmed: "Tick the box to confirm before releasing.",
  ...DECLARE_COPY,
};
