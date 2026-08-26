const IDENTITY_RE = /Player "([^"]+)"\s*\(id=([0-9A-F]{40})(?![0-9A-F])/u;

export function parseIdentity(raw: string): { gamertag: string; dayzId: string } | null {
  const m = IDENTITY_RE.exec(raw);
  if (!m) return null;
  return { gamertag: m[1]!, dayzId: m[2]! };
}
