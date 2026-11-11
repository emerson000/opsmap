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
| `OPSMAP_SECRET_KEY_FILE` | Key that seals stored Vikunja tokens (default `DATA_DIR/secrets/master.key`). |
| `OPSMAP_DEV_USERS`, `OPSMAP_ADMIN_EMAILS` | Development sign-in only; refused in production and on a non-loopback `HOST`. |

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
