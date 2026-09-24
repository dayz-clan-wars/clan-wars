/**
 * The /map URL's parameters. `result` is a one-shot notice, and `at` is the
 * grid square to open on. Both are read by the page; neither ever carries a
 * metre coordinate.
 */

/** The same address without `?result`, as a path (for `history.replaceState`). */
export function withoutResult(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("result");
  return `${url.pathname}${url.search}${url.hash}`;
}
