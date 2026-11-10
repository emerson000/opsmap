# opsmap

A personal operations map: tasks and concerns drawn as APP-6 / MIL-STD-2525 style symbols on a pseudo-terrain map, with an HQ at the center and life sectors around it.

## Run locally

Requires Node.js 24 or newer (the server uses `node:sqlite`).

```bash
npm ci
npm run build        # client bundle the server serves
npm run dev:server   # API, sign-in and WebSocket on http://127.0.0.1:8080, data in ./.data
npm run dev          # optional, second terminal: client with hot reload on http://localhost:5173
```

Open http://127.0.0.1:8080 (or http://localhost:5173 with `npm run dev`) and sign in as **alice** (admin) or **bob**. These development users exist only while the server listens on a loopback address, and any loopback origin is accepted; in production the browser origin must equal `PUBLIC_URL`, and a mismatch is logged. Override the defaults with `OPSMAP_DEV_USERS`, `OPSMAP_ADMIN_EMAILS`, `DATA_DIR` and `PORT`; the Vite proxy follows `OPSMAP_API` (default `http://127.0.0.1:8080`).

For a production-style run: `npm run build && npm start`, with `PUBLIC_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_GROUP` and `OPSMAP_ADMIN_SUBS` set, behind HTTPS.

Tests: `npm test` (unit), `npm run check` (types), `npx playwright test` (browser; run `npx playwright install` once).

Each map has a calendar zone in `settings.tz`. The server stamps its zone into every map: `OPSMAP_TZ`, else `TZ`, else `UTC`. Calendar commands, due-date rings and the morning turn use the map's zone on every machine. The scheduler runs each map's morning turn at 04:00 in that zone, and the nightly backup at 04:00 in the server's zone.

Set `OPSMAP_ADMIN_SUBS` to a comma-separated list of OIDC subjects (`sub` claims). Legacy `OPSMAP_ADMIN_EMAILS` grants access only when the ID token explicitly includes `email_verified: true`. Development login users have verified fixture addresses. Sessions expire absolutely 24 hours after login, including existing sessions created before this limit; use does not extend them. Provider access and refresh tokens are not retained, so group removal or account disablement can take up to 24 hours to take effect. Log out to revoke a browser session immediately.

Each MCP token has its own undo history. Its changes retain the human author and show the token name beside their initials. Token names can be reused after revocation; the new token has a separate undo history. Browser reconnects always receive the authoritative document, replacing cached history after a database restore. Logs retain 2,000 entries, snapshots retain three copies, expired sessions are removed by maintenance, and nightly backups retain 14 copies. The operation journal remains complete for replay and audit; monitor disk use.

The default listener is `127.0.0.1`; development users require a loopback listener and are forbidden in production. WebSocket frames and presence updates have per-connection rate limits, and MCP requests have per-token limits. Text arguments are limited to 2,048 characters. CSP permits local resources and inline styles required by the map.

The Docker image runs as the unprivileged `node` user.

Restore from a completed `/data/backups/opsmap-YYYY-MM-DD.db` file, which the app creates with `VACUUM INTO` and atomically renames. Stop the container, replace `/data/opsmap.db` with that backup, and remove the stopped database's `opsmap.db-wal` and `opsmap.db-shm` files before starting it. A generic copy of the live database without its matching WAL is not a restore source.

## Phones, tablets and touch

Below 760 px wide (or a touch screen under 500 px tall) the app switches to the phone layout: a compact top bar (DTG, live dot, online chips, menu), the map full screen, the command bar docked at the bottom above the on-screen keyboard, and one bottom sheet for the inspector, situation summary and order log (peek, half, full). From 760 to 1279 px the side columns stay and the less-used top-bar items move into the menu. The page never scrolls or zooms: the map owns its gestures (`touch-action: none`), everything else is `touch-action: pan-x pan-y`, the viewport sets `maximum-scale=1, user-scalable=no`, and iOS `gesture*` events are refused. A landscape phone gets the sheet as a right-hand column.

Touch gestures on the map: drag pans, pinch zooms, double-tap on ground zooms in. Tap a unit for its card, double-tap or long-press and let go for every field, long-press then drag to move it. A second finger during a move cancels it and pinches. Drag the round handle under a selected friendly onto a hostile to attack. Long-press open ground to capture there. OBJ, EA and NAI areas move the same way (mouse: drag the outline or label; double-click for its card). The legend's Gestures tab lists all of this.

Theme follows the system (`prefers-color-scheme`, live) unless this browser picks Day or Night; the choice is stored in `localStorage` under `opsmap.ui.theme`, never in the shared map. `public/theme-init.js` sets the theme before first paint (an external file, so the CSP needs no hash).

Control measures: `/obj|/ea|/nai move <name> [to <sector>] <hq|near|mid|far>` (the ring words `close`, `deep` and `aoi` also work everywhere) or `move <name> near <unit>`; `/pl date <name> <date>` re-dates a phase line (phase lines sit at their date and are not dragged). Both are ordinary undoable ops.

Command posts: `/cp <unit> main|tac|alt|rear` marks a unit as a headquarters of that type (the HQ staff, with MAIN, TAC, ALT or REAR in place of the icon, in every view); `/cp <unit> none` clears it, restoring its icon. The inspector has the same choice. Suggested meanings: MAIN home base, TAC where you work today, ALT the fallback, REAR errands and logistics.

Clearing orders: `/halt <unit>` cancels all of a unit's own orders, and `/halt <unit> advance|move|attack|axis|link` only that kind (`/stop` and `/cancel` also work); each order in the inspector has a ✕ that does the same for that one order. Undo restores them.

Task forces: a unit becomes a task force (TF bracket) when another unit is attached to it, `/attach <unit> to <tf>`. Only the task force itself may hold orders that cross a sector boundary, e.g. `/attack <tf> <hostile in another sector>`; its attached units may not.

Sector HQs as targets: `/advancing <hostile> on sector hq` (its own sector's HQ) or `on <sector> hq`, and `/moving <unit> to sector hq` for a friendly falling back. The targeted sector HQ then shows in every view. Moving the unit to another sector cancels the order; removing the sector drops it, or retargets it to the receiving sector's HQ with `reassign`. Plain `hq` is still the center.

Headquarters of any identity: `/new hostile bn hq "Their legal team" as LEGAL` (or long-press open ground → New hostile HQ), `/attach <unit> to LEGAL` for each unit it controls, and optionally `/cp LEGAL main`. The HQ staff follows the symbol standard, so on a hostile diamond it hangs from the left corner rather than forming a flag. Dashed command lines join attached units to their HQ or task force, in the HQ's color: always in Staff and Detail, and in Commander for the selected HQ or member.

Areas (OBJ, EA, NAI) hold units. `/ea join <name> <unit>…` moves units inside an area and `/ea leave <name> <unit>…` releases them; on the map, drop a unit inside an area's outline to add it and drag it out past the outline to remove it, or pick the area in the unit's inspector. A unit belongs to at most one area, and moving a member to another sector by command takes it out. The outline is centered on its members and grows to enclose them; `/ea size <name> small|medium|large|xl` sets the smallest it draws (medium by default, also on the area's card). Moving an area moves its members with it. The same forms work for `/obj` and `/nai`.

## Multiple maps

The server holds any number of shared maps (up to 50). Each map has its own op journal, sequence numbers, snapshots, undo history, presence and 04:00 morning turn; users, sessions, tokens and backups are shared, and everything stays in the one `opsmap.db`. The first map in creation order is the default. Upgrading an existing database moves its journal into the map `main`, named "Main", without changing it.

The top-bar **Map** button (the phone menu's Map section) lists the maps and opens one, and creates a new empty map (five standard sectors), duplicates the open map, creates one from an exported JSON file, or renames the open map. Any signed-in user can do these; only an administrator can delete a map, and the last map cannot be deleted. Deleting a map removes its journal (nightly backups keep earlier copies) and moves anyone on it to the default map. The open map is in the address bar as `?map=<id>` (absent for the default map) and is remembered per browser in `localStorage` under `opsmap.ui.map`. Switching waits until this map's pending changes are saved.

HTTP: `GET /api/maps`, `POST /api/maps {name, doc?}`, `PATCH /api/maps/:id {name}`, `DELETE /api/maps/:id` (admin). Writes require the app's own `Origin`. `GET /api/export` and admin `POST /api/import` take `?map=<id or name>` and use the default map without it. The WebSocket `hello` carries `map`; the `welcome` names the map served and lists all maps, and a `maps` frame announces creations, renames and deletions.

MCP: `opsmap_maps` lists the maps. `opsmap_command`, `opsmap_query` and `opsmap_sitrep` take an optional `map` (id, or name ignoring case) and use the default map without it.
