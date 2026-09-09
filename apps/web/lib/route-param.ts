/**
 * A dynamic route segment as the page should read it. Next hands `params`
 * over percent-encoded — a gamertag with a space arrives as `IGC%20slide` —
 * and a lookup on the raw value finds nobody. Malformed encoding (a bare
 * `%`) is not worth a 500: the raw value is looked up and misses honestly.
 */
export function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
