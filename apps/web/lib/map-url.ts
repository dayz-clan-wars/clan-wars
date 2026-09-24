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

const GRID_KEY = /^\d{6}$/u;

/**
 * Where a pin form lands afterwards: the result notice, plus the grid square
 * to reopen on. Without `at`, the 303 reload ran `fitBounds` again and every
 * drop or delete threw the player back out to the whole world.
 *
 * ⚠️ `at` must be exactly six digits (`gridRefKey`) or it is dropped. On the
 * delete form it is player-supplied, and anything else could smuggle a second
 * query parameter or a metre coordinate into the URL.
 */
export function pinResultPath(result: string, at: string | null): string {
  const base = `?result=${encodeURIComponent(result)}`;
  return at !== null && GRID_KEY.test(at) ? `${base}&at=${at}` : base;
}
