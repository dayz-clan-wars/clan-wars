const LABEL = /^\s*\**\s*(boris|pavel)\s*\**\s*:\**\s*(.*)$/i;

export type Turn = { speaker: "Boris" | "Pavel"; text: string };

/**
 * Split the raw two-host narrative (Boris:/Pavel: lines, before any markdown formatting) into
 * ordered turns. A speaker label starts a turn; non-label lines append to the current turn.
 * Lines before the first label are ignored; empty turns are dropped.
 */
export function parseDialogue(narrative: string): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const raw of (narrative ?? "").split("\n")) {
    const line = raw.trim();
    const m = line.match(LABEL);
    if (m) {
      const speaker = (m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase()) as Turn["speaker"];
      cur = { speaker, text: m[2]!.trim() };
      turns.push(cur);
    } else if (cur && line) {
      cur.text += (cur.text ? " " : "") + line;
    }
  }
  return turns.filter((t) => t.text);
}
