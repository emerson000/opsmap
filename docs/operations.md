# Running opsmap in production

## Configuration

| Variable | Meaning |
|---|---|
| `PUBLIC_URL` | The HTTPS origin users open, without a trailing slash. Required in production. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | OpenID Connect sign-in. Required in production. |
| `OIDC_GROUP` | Group a user must have to sign in (default `opsmap_users`). |
| `OPSMAP_ADMIN_SUBS` | Comma-separated OIDC subjects (`sub`) of administrators. |
| `HOST`, `PORT` | Listener (default `127.0.0.1:8080`; use `HOST=0.0.0.0` in a container). |
| `DATA_DIR` | Database, backups and secrets (default `/data`). |
| `OPSMAP_TZ` | Calendar zone for maps (else `TZ`, else `UTC`). |
| `VIKUNJA_URL` | Turns on Vikunja sync. See [vikunja.md](vikunja.md). |
| `ASANA_SYNC` | `1` or `true` turns on Asana sync. See [asana.md](asana.md). |
| `TASKSYNC_WEBHOOKS` | `auto` (default): task services post webhooks to `PUBLIC_URL` when they can reach it; `on`: try even when it looks private; `off`: poll only. See [Running on a LAN or as a dev server](#running-on-a-lan-or-as-a-dev-server). |
| `TASKSYNC_POLL_SECONDS` | Overrides how often task sync polls, for every service (15 seconds at least). For development. |
| `OPSMAP_SECRET_KEY_FILE` | Key that seals stored task service tokens (default `DATA_DIR/secrets/master.key`). Back it up separately from the database. |
| `OPSMAP_DEV_USERS`, `OPSMAP_ADMIN_EMAILS` | Development sign-in only; refused in production and on a non-loopback `HOST`. |

## Running on a LAN or as a dev server

Task sync ([task-sync.md](task-sync.md)) polls every bound map, and that works everywhere: on a development server at `http://127.0.0.1:8080`, on a LAN, on a tailnet and on the public internet. Webhooks only make changes from the service arrive sooner, and only work when the service can reach `PUBLIC_URL`. The server works out a delivery mode for each bound map and never logs an error because webhooks cannot work.

| Mode | When | `/tasks status` (sidebar) |
|---|---|---|
| off | `TASKSYNC_WEBHOOKS=off`; `PUBLIC_URL` unset or loopback; or `PUBLIC_URL` does not meet the service's needs (Asana needs a public HTTPS address) | `polling every 2 minutes (webhooks off: Asana needs a public HTTPS address; PUBLIC_URL is a private address (192.168.1.5))` or `polling every minute (webhooks need PUBLIC_URL to be an address Vikunja can reach)` (`Checking every 2 min. Instant updates need a public HTTPS address.`) |
| pending | registered, no signed delivery in the last 15 minutes | `5 webhooks, none delivered yet: ‹hint› · polling every minute`; after earlier deliveries, `5 webhooks · last delivery 18:22:59Z · polling every minute` (`Checking every 1 min. Waiting for the first instant update.`) |
| live | a signed delivery in the last 15 minutes | `1 webhook · last delivery 12:00:00Z` (`Live updates`) |
| failed | the service refused the webhook, or (Asana) its handshake did not arrive within 30 seconds | `webhooks failed: ‹reason›, retrying at 12:10:00Z · polling every 2 minutes` (`Checking every 2 min. Instant updates failed; trying again later.`) |

- A loopback, private (RFC 1918), CGNAT or Tailscale (`100.64.0.0/10`), link-local or IPv6 unique-local address counts as private, and so does a name ending in `.local`, `.lan`, `.internal`, `.home.arpa` or `.ts.net`. The server resolves `PUBLIC_URL` at start and every hour.
- Asana needs a public HTTPS `PUBLIC_URL`, for example through a reverse proxy with a certificate or a tunnel. On anything else it polls every 2 minutes and makes no webhook calls.
- A Vikunja on the same LAN can reach a private address if it runs with `VIKUNJA_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS=true`. Start opsmap with `TASKSYNC_WEBHOOKS=on` so it registers webhooks for a private `PUBLIC_URL`.
- While webhooks are not live, opening a map in a browser, coming back to its tab, or an MCP call on it pulls within about 2 seconds.
- For development, `TASKSYNC_POLL_SECONDS=15` polls every 15 seconds. `OPSMAP_FAKE_PROVIDER=1` with `NODE_ENV=test` adds an in-memory service named Fake, which the e2e tests use.

## Upgrading to provider-neutral task sync

A server that synced with Vikunja under `/vk` moves its sync data into the provider-neutral tables on its first start ([task-sync.md](task-sync.md#upgrading-from-a-server-that-synced-only-with-vikunja)). Before you deploy:

1. Back up the database: take a completed nightly backup, or stop the container and copy `opsmap.db` with its `-wal` and `-shm` files. Keep the secret key file with it.
2. Run the dry run on a copy, not on the live database: `DATA_DIR=/path/to/copy npx tsx server/cli.ts tasks migrate --dry-run` (or `node dist/server/cli.js tasks migrate --dry-run` in the image, with `DATA_DIR` set to the copy). It changes no sync data, but it opens the database with the server's schema setup, which can add tables or columns. Check that each map says `ok` for its latest snapshot, the binding you expect and the number of linked units. An older snapshot marked `fails, deleted on migrate` is deleted by the move; the map starts from its latest one.
3. Make sure the secret key file (`OPSMAP_SECRET_KEY_FILE`, or `DATA_DIR/secrets/master.key`) is present where the new server runs. Tokens are copied to the new table only when the server can open them. Without the key file a server with a task service configured makes a new key, logs how many tokens it could not open, and keeps them in the old table until a start that has the right key; if the key is lost, every user must connect their account again.
4. Deploy, then run `/tasks status` on each bound map. It should match its `/vk status` from before the deploy: the same project, sectors and linked units. Only the last sync time differs.
5. Vikunja webhooks keep their path (`/api/vikunja/hook/‹map›`), so the existing ones keep delivering and are not made again. A delivery should show in `/tasks status` within a few minutes of a change in Vikunja.
6. Browser tabs opened before the deploy must reload before `/tasks` and the Task sync section work.

## Development sign-in

Open http://127.0.0.1:8080 (or http://localhost:5173 with `npm run dev`) and sign in as **alice** (admin) or **bob**. These development users exist only while the server listens on a loopback address, and any loopback origin is accepted; in production the browser origin must equal `PUBLIC_URL`, and a mismatch is logged. Override the defaults with `OPSMAP_DEV_USERS`, `OPSMAP_ADMIN_EMAILS`, `DATA_DIR` and `PORT`; the Vite proxy follows `OPSMAP_API` (default `http://127.0.0.1:8080`).

## Time zone

Each map has a calendar zone in `settings.tz`. The server stamps its zone into every map: `OPSMAP_TZ`, else `TZ`, else `UTC`. Calendar commands, due-date rings and the morning turn use the map's zone on every machine. The scheduler runs each map's morning turn at 04:00 in that zone, and the nightly backup at 04:00 in the server's zone.

## Sign-in and sessions

Set `OPSMAP_ADMIN_SUBS` to a comma-separated list of OIDC subjects (`sub` claims). Legacy `OPSMAP_ADMIN_EMAILS` grants access only when the ID token explicitly includes `email_verified: true`. Development login users have verified fixture addresses. Sessions expire absolutely 24 hours after login, including existing sessions created before this limit; use does not extend them. Provider access and refresh tokens are not retained, so group removal or account disablement can take up to 24 hours to take effect. Log out to revoke a browser session immediately.

## Retention

Browser reconnects always receive the authoritative document, replacing cached history after a database restore. Logs retain 2,000 entries, snapshots retain three copies, expired sessions are removed by maintenance, and nightly backups retain 14 copies. The operation journal remains complete for replay and audit; monitor disk use.

## Security

The default listener is `127.0.0.1`; development users require a loopback listener and are forbidden in production. WebSocket frames and presence updates have per-connection rate limits, and MCP requests have per-token limits. Text arguments are limited to 2,048 characters. CSP permits local resources and inline styles required by the map. The Docker image runs as the unprivileged `node` user.

## Backup and restore

Restore from a completed `/data/backups/opsmap-YYYY-MM-DD.db` file, which the app creates with `VACUUM INTO` and atomically renames. Stop the container, replace `/data/opsmap.db` with that backup, and remove the stopped database's `opsmap.db-wal` and `opsmap.db-shm` files before starting it. A generic copy of the live database without its matching WAL is not a restore source.
