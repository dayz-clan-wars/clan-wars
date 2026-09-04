import { describe, it, expect } from "vitest";
import { EncryptJWT } from "jose";
import { sessionKey, encodeSession, decodeSession, type Session } from "../lib/auth/session";

// 32 random bytes, base64 — the shape `openssl rand -base64 32` produces.
const SECRET = "5S9y0kZ0Yb0k7t0mQ0nT0pV0sX0uZ0wA0yC0eF0gH0k=";
const OTHER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const session: Session = {
  sub: "1545252643155353640",
  name: "SubatomicRacer",
  avatar: "a1b2c3",
  guild: true,
  nextCheckAt: 1_800_000_000,
};

describe("sessionKey", () => {
  it("decodes a 32-byte base64 secret", () => {
    expect(sessionKey(SECRET)).toHaveLength(32);
  });

  it("refuses a secret that is not 32 bytes", () => {
    // ⚠️ A short key silently weakens A256GCM instead of failing, so this
    // throws rather than padding. A truncated SESSION_SECRET in .env is the
    // realistic way this happens.
    expect(() => sessionKey("dG9vLXNob3J0")).toThrow(/32 bytes/);
  });
});

describe("session round trip", () => {
  it("decodes what it encoded", async () => {
    const key = sessionKey(SECRET);
    const decoded = await decodeSession(await encodeSession(session, key), key);
    expect(decoded).toEqual(session);
  });

  it("returns null for a token encrypted with a different key", async () => {
    const token = await encodeSession(session, sessionKey(SECRET));
    expect(await decodeSession(token, sessionKey(OTHER))).toBeNull();
  });

  it("returns null for garbage", async () => {
    expect(await decodeSession("not-a-token", sessionKey(SECRET))).toBeNull();
    expect(await decodeSession("", sessionKey(SECRET))).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const key = sessionKey(SECRET);
    const expired = await new EncryptJWT({ ...session })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt(1_600_000_000)
      .setExpirationTime(1_600_000_001)
      .encrypt(key);
    expect(await decodeSession(expired, key)).toBeNull();
  });

  it("returns null when the payload is missing a required field", async () => {
    // ⚠️ A token from an older payload shape decrypts fine and then has holes.
    // Treating it as signed out is right; trusting it would mean `guild`
    // reading undefined and a non-member being let through.
    const key = sessionKey(SECRET);
    const partial = await new EncryptJWT({ sub: "123" })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .encrypt(key);
    expect(await decodeSession(partial, key)).toBeNull();
  });
});
