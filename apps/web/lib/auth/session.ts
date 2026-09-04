import { EncryptJWT, jwtDecrypt } from "jose";

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

export async function encodeSession(session: Session, key: Uint8Array): Promise<string> {
  return new EncryptJWT({ ...session })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("7d")
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
      typeof payload.nextCheckAt !== "number"
    ) {
      return null;
    }
    return {
      sub: payload.sub,
      name: payload.name,
      avatar: typeof payload.avatar === "string" ? payload.avatar : null,
      guild: payload.guild,
      nextCheckAt: payload.nextCheckAt,
    };
  } catch {
    return null;
  }
}
