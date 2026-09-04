import { Discord } from "arctic";

/**
 * The only file here that touches the network.
 *
 * ⚠️ Everything it returns is a raw status code, decided elsewhere. The policy
 * lives in `membership.ts` so it can be tested without a network.
 */

const API = "https://discord.com/api/v10";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function discordClient(): Discord {
  return new Discord(
    env("DISCORD_CLIENT_ID"),
    env("DISCORD_CLIENT_SECRET"),
    `${env("WEB_BASE_URL")}/api/auth/callback`,
  );
}

/**
 * ⚠️ Authenticated with OUR bot token, not the player's. This is what lets the
 * 15-minute re-check work forever from a user id alone — no user access token
 * is stored, so there is none to expire or leak.
 */
export async function guildMemberStatus(userId: string): Promise<number | "network-error"> {
  // ⚠️ Read OUTSIDE the try. A missing/misconfigured env var must throw, not
  // be swallowed into "network-error" -> "unknown" -> last-known-good forever.
  // Inside the try, a revoked token, a deleted guild id and a real Discord
  // outage were all indistinguishable and all silent.
  const guildId = env("DISCORD_GUILD_ID");
  const token = env("DISCORD_JOIN_BOT_TOKEN");
  try {
    const res = await fetch(`${API}/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${token}` },
      cache: "no-store",
    });
    return res.status;
  } catch (err) {
    console.error("guildMemberStatus: request to Discord failed", err);
    return "network-error";
  }
}

/**
 * Adds the player to the guild. Requires the bot to hold CREATE_INSTANT_INVITE
 * and the access token to carry the `guilds.join` scope.
 *
 * ⚠️ Discord requires the bot token and the access token to belong to the SAME
 * application — which is why the web app has its own Discord application
 * rather than borrowing the game bot's token.
 *
 * 201 = added, 204 = already a member, 403 = banned from the guild.
 */
export async function addGuildMember(
  userId: string,
  accessToken: string,
): Promise<number | "network-error"> {
  // ⚠️ See guildMemberStatus above — read outside the try for the same reason.
  const guildId = env("DISCORD_GUILD_ID");
  const token = env("DISCORD_JOIN_BOT_TOKEN");
  try {
    const res = await fetch(`${API}/guilds/${guildId}/members/${userId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    return res.status;
  } catch (err) {
    console.error("addGuildMember: request to Discord failed", err);
    return "network-error";
  }
}

/** Reads the player's identity, then the caller discards the token. */
export async function currentUser(
  accessToken: string,
): Promise<{ id: string; username: string; avatar: string | null } | null> {
  try {
    const res = await fetch(`${API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`currentUser: Discord returned ${res.status}`);
      return null;
    }
    const u = (await res.json()) as { id: string; username: string; avatar: string | null };
    return { id: u.id, username: u.username, avatar: u.avatar ?? null };
  } catch (err) {
    console.error("currentUser: request to Discord failed", err);
    return null;
  }
}
