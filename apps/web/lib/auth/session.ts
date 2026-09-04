import { EncryptJWT, jwtDecrypt } from "jose";
import { SESSION_MAX_AGE_SECONDS } from "./cookies";

/**
 * The session cookie's payload.
 *
 * ⚠️ Identity ONLY. Nothing about factions, rosters or entitlement may be
 * cached here. The cookie is written once and read for seven days with no
 * transaction updating it, so any faction fact stored here is a second source
 * of truth that is wrong the moment the first one changes.
 */
export type Session = {
  /** Discord user id (snowflake). */
  sub: string;
  name: string;
  avatar: string | null;
  /** Whether the player is in the Clan Wars guild, as of `nextCheckAt` minus the cadence. */
  guild: boolean;
  /** Epoch seconds after which membership must be re-verified. */
  nextCheckAt: number;
  /**
   * Epoch seconds of the ORIGINAL login. Fixed for the life of the session —
   * middleware carries it through unchanged on every re-issue. This, not
   * "now", anchors the 7-day expiry: without it, a re-issue on every
   * 15-minute recheck resets the clock to "now + 7d" and a weekly visitor
   * never re-authenticates. Spec §2.6 rejected a session that never expires.
   */
  authAt: number;
};

/**
 * ⚠️ Decoded with `atob`, not `Buffer`. Middleware runs on the edge runtime
 * where `Buffer` is not guaranteed; this file is imported by middleware.
 */
export function sessionKey(secret: string): Uint8Array {
  const binary = atob(secret);
  if (binary.length !== 32) {
    throw new Error(`SESSION_SECRET must decode to 32 bytes, got ${binary.length}`);
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * ⚠️ Expiry is `authAt + SESSION_MAX_AGE_SECONDS`, an absolute timestamp —
 * NOT `setExpirationTime("7d")`, which jose resolves as "7 days from now".
 * That form re-anchors on every encode, and middleware re-encodes on every
 * 15-minute recheck, so a weekly visitor's session would never actually
 * expire. Passing a `number` to `setExpirationTime` sets `exp` to exactly
 * that value (see jose's `numericDate`), including one already in the past —
 * which is exactly how a session whose `authAt` is more than 7 days old
 * decodes to null below, without a separate age check.
 */
export async function encodeSession(session: Session, key: Uint8Array): Promise<string> {
  return new EncryptJWT({ ...session })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(session.authAt + SESSION_MAX_AGE_SECONDS)
    .encrypt(key);
}

/**
 * ⚠️ Returns null for every failure and never throws or distinguishes them.
 * Tampering, an expired token and a rotated SESSION_SECRET are all just
 * "signed out" to the caller. Reporting which one it was would tell an
 * attacker whether their forgery decrypted.
 */
export async function decodeSession(token: string, key: Uint8Array): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtDecrypt(token, key);
    if (
      typeof payload.sub !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.guild !== "boolean" ||
      typeof payload.nextCheckAt !== "number" ||
      typeof payload.authAt !== "number"
    ) {
      return null;
    }
    return {
      sub: payload.sub,
      name: payload.name,
      avatar: typeof payload.avatar === "string" ? payload.avatar : null,
      guild: payload.guild,
      nextCheckAt: payload.nextCheckAt,
      authAt: payload.authAt,
    };
  } catch {
    return null;
  }
}
