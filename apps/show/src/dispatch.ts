/** Validate CLI flag combinations before running. Returns the dispatch kind or a usage error. */
export function dispatch(values: {
  "dry-run"?: boolean;
  "print-prompt"?: boolean;
  render?: string;
  force?: boolean;
  repost?: boolean;
}): { kind: "review" | "service" } | { kind: "usage"; message: string } {
  // ⚠️ `--print-prompt` must pair with at least one review mode (--dry-run or --render).
  if (values["print-prompt"] && !values["dry-run"] && values.render === undefined) {
    return { kind: "usage", message: "--print-prompt must go with --dry-run or --render" };
  }

  // ⚠️ Empty `--render ""` is a usage error, not a service run.
  if (values.render === "") {
    return { kind: "usage", message: "--render requires a directory path, not empty" };
  }

  // ⚠️ `--force` or `--repost` together with review modes is a usage error.
  const isReviewMode = values["dry-run"] || values.render !== undefined;
  if (isReviewMode && (values.force || values.repost)) {
    return { kind: "usage", message: "--force and --repost are service-only, not --dry-run or --render" };
  }

  // Dispatch to review mode if either `--dry-run` or `--render` is set.
  if (isReviewMode) {
    return { kind: "review" };
  }

  // Otherwise, this is a service run.
  return { kind: "service" };
}
