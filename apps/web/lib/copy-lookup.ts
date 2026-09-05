/**
 * Look up `key` in a plain copy table without falling onto `Object.prototype`.
 * `key` comes straight off a query string, so `?result=__proto__` (or
 * `toString`, `constructor`, ...) must miss rather than return a prototype
 * property — `Object.hasOwn` is what makes that miss.
 */
export function lookupCopy<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
