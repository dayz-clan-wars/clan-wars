import readline from "node:readline";

// ⚠️ The full `youtube` scope: videos.update (privacy) and playlistItems.insert need it, and the
// KOTH token's youtube.upload + youtube.readonly cannot do either (spec §9.1).
const SCOPE = "https://www.googleapis.com/auth/youtube";
const REDIRECT = "http://localhost"; // a Desktop OAuth client; the redirect page will not load, so copy the code from the URL

const ask = (q: string) => new Promise<string>((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); res(a.trim()); });
});

const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET first.");
  process.exit(2);
}
const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: clientId, redirect_uri: REDIRECT, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent",
}).toString();
console.log(`\n1) Open this URL in a browser signed in to the show's YouTube channel:\n\n${authUrl}\n`);
console.log("2) Approve. The browser goes to http://localhost/?code=... and fails to load, which is expected.");
console.log("3) Copy the value of the code parameter from the address bar.\n");
const code = await ask("Paste the authorization code here: ");
const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: REDIRECT, grant_type: "authorization_code" }).toString(),
});
const j = (await res.json().catch(() => null)) as { refresh_token?: string } | null;
if (!res.ok || !j?.refresh_token) {
  console.error(`\nToken exchange failed ${res.status}. If there is no refresh_token, run this again.`);
  process.exit(1);
}
console.log(`\nAdd this line to /opt/clan-wars/.env:\n\nYOUTUBE_REFRESH_TOKEN=${j.refresh_token}\n`);
