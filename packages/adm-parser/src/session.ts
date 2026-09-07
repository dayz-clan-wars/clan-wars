export type SessionEvent = { kind: "connected" | "disconnected"; dayzId: string; gamertag: string };

// ⚠️ Anchored on the identity block's own closing paren, the same way flag.ts and
// emote.ts are. The gamertag is attacker-controlled and sits before the identity
// block, so an unanchored pattern would let a name like `x is connected` on an
// unrelated line forge a session event.
const CONNECTING_RE = /\(id=[0-9A-F]{40}[^)]*\)\s*is connecting\s*$/u;
const CONNECTED_RE = /Player "([^"]+)"\s*\(id=([0-9A-F]{40})[^)]*\) is connected\s*$/u;
const DISCONNECT_RE = /Player "([^"]+)"\s*\(id=([0-9A-F]{40})[^)]*\) has been disconnected\s*$/u;

export function parseSession(raw: string): SessionEvent | null {
  if (CONNECTING_RE.test(raw)) return null;

  const connected = CONNECTED_RE.exec(raw);
  if (connected) return { kind: "connected", gamertag: connected[1]!, dayzId: connected[2]! };

  const disconnected = DISCONNECT_RE.exec(raw);
  if (disconnected) return { kind: "disconnected", gamertag: disconnected[1]!, dayzId: disconnected[2]! };

  return null;
}
