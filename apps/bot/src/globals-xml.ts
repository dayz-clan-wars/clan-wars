import { escapeRe, maskComments } from "./events-xml.js";

/**
 * The one live `<var name="…" … />` tag for `name`, located in the comment-masked
 * document so a commented-out copy is never taken for it.
 *
 * ⚠️ Same refusals as events.xml's splice, for the same reason: a missing or
 * duplicated var would otherwise be a write that reports success and changes
 * nothing the server reads.
 */
function locate(xml: string, name: string): { value: number; valueFrom: number; valueTo: number } {
  const masked = maskComments(xml);
  // The closing quote after the name is what stops `CleanupLifetimeDead` matching
  // `CleanupLifetimeDeadPlayer`.
  const tag = new RegExp(`<var\\s+name="${escapeRe(name)}"[^>]*>`, "g");
  const matches = [...masked.matchAll(tag)];
  if (matches.length === 0) throw new Error(`globals.xml: no <var name="${name}"> found`);
  if (matches.length > 1) {
    throw new Error(`globals.xml: <var name="${name}"> appears more than once (${matches.length}×) outside comments — refusing to guess which one is live`);
  }
  const m = matches[0]!;
  const vm = /\svalue="(-?\d+)"/.exec(m[0]);
  if (!vm) throw new Error(`globals.xml: <var name="${name}"> has no numeric value`);
  const valueFrom = m.index! + vm.index + vm[0].indexOf('"') + 1;
  return { value: Number(vm[1]), valueFrom, valueTo: valueFrom + vm[1]!.length };
}

/** The live value of one integer `<var>` in globals.xml. */
export function readGlobalVar(xml: string, name: string): number {
  return locate(xml, name).value;
}

/**
 * Set one integer `<var>`'s `value`, returning the new document and whether
 * anything changed.
 *
 * ⚠️ A targeted splice, never a parse-and-reserialize: globals.xml belongs to the
 * operator, and everything outside the one attribute value comes back
 * byte-identical. A missing var throws rather than being added — a var the file
 * never carried is one the operator never meant to set.
 */
export function setGlobalVar(xml: string, name: string, value: number): { xml: string; changed: boolean } {
  const at = locate(xml, name);
  if (at.value === value) return { xml, changed: false };
  return { xml: xml.slice(0, at.valueFrom) + String(value) + xml.slice(at.valueTo), changed: true };
}
