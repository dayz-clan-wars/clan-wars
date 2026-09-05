# Site foundation — deploy note

No migration. The web container gains one environment variable and its first
database read.

1. Read `docker-compose.yml`'s `web` service: `DATABASE_URL` points at
   `factions_live` on the compose network. Confirm `depends_on: postgres`.
2. Build: `docker compose build web`. The build compiles Tailwind and the three
   transpiled `@factions/*` packages; a failure here is the build, not the deploy.

   Verified at b102fd2 by running the isolated standalone output with no
   ancestor `node_modules`: `/` → 200 and `/me` reached the driver's `connect`
   (ECONNREFUSED against a dead DSN), so the bundle carries `postgres` and the
   transpiled packages; the acceptance step below checks data, not wiring.
3. `docker compose up -d web`. Watch `docker compose logs -f web` for the
   standalone server's ready line.
4. Acceptance, in a browser signed in as a linked member: `/me` shows the
   gamertag from `identity_links` and the clan from `faction_members`. Signed
   out, `/me` redirects to `/login?next=/me`. `/mobile` and `/link` are 404.
5. ⚠️ If `/me` renders "Your session could not be read" for everyone,
   `SESSION_SECRET` in the web container differs from the one the cookies
   were signed with — nothing is wrong with the database.
