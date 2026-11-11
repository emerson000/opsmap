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

## Sound

Three quiet console cues, synthesized in the browser (no audio files): two rising tones for a new track (from anyone: you, another user, an agent or Vikunja), five quick beeps for a new hostile or suspect track (or one identified as hostile), and two falling tones when a hostile is destroyed. Nothing else makes a sound. Loading, reconnecting and switching maps are silent, and there is at most one cue every 1.2 seconds, so a burst of changes gives one. The speaker button in the top bar (phone: menu → Sound) mutes them; the choice is kept per browser in `localStorage` under `opsmap.ui.sound`. Browsers play sound only after a first click or key press.

## Phones, tablets and touch

Below 760 px wide (or a touch screen under 500 px tall) the app switches to the phone layout: a compact top bar (DTG, live dot, online chips, menu), the map full screen, the command bar docked at the bottom above the on-screen keyboard, and one bottom sheet for the inspector, situation summary and order log (peek, half, full). From 760 to 1279 px the side columns stay and the less-used top-bar items move into the menu. The page never scrolls or zooms: the map owns its gestures (`touch-action: none`), everything else is `touch-action: pan-x pan-y`, the viewport sets `maximum-scale=1, user-scalable=no`, and iOS `gesture*` events are refused. A landscape phone gets the sheet as a right-hand column.

The bottom sheet opens and closes with one tap on its open tab or its grab bar. It reopens at the height it last had open (half at first); drag the header for any height, and tap the other tab to switch without closing.

Touch gestures on the map: drag pans, pinch zooms, double-tap on ground zooms in. Tap a unit for its card, double-tap or long-press and let go for every field, long-press then drag to move it. A second finger during a move cancels it and pinches. Drag the round handle under a selected friendly onto a hostile to attack. Long-press open ground to capture there. OBJ, EA and NAI areas move the same way (mouse: drag the outline or label; double-click for its card). The legend's Gestures tab lists all of this.

Theme follows the system (`prefers-color-scheme`, live) unless this browser picks Day or Night; the choice is stored in `localStorage` under `opsmap.ui.theme`, never in the shared map. `public/theme-init.js` sets the theme before first paint (an external file, so the CSP needs no hash).

Right-click on desktop: on a unit, a menu of its common actions. Attack…, Move…, Due date…, Note… and Block… put the command in the command bar for you to finish; Unblock, Unpin, Halt orders, key terrain, Done (Destroyed for a threat) and Drop (Bypassed) run at once and show a toast with Undo. Right-click also selects the unit. On open ground it opens the capture menu, and on an OBJ, EA or NAI its card. With a unit focused, the keyboard's menu key or Shift+F10 opens its menu; arrow keys move through it and Escape closes it. Touch keeps long-press.

Control measures: `/obj|/ea|/nai move <name> [to <sector>] <hq|near|mid|far>` (the ring words `close`, `deep` and `aoi` also work everywhere) or `move <name> near <unit>`; `/pl date <name> <date>` re-dates a phase line (phase lines sit at their date and are not dragged). Both are ordinary undoable ops.

AO size: `/ao size small|medium|large|xl` (also `/sector size`, and the AO SIZE buttons in the Situation panel) sets how much room the rings give each symbol, for the whole map and every user. Large and XL draw symbols smaller against the rings and space them closer, so a crowded band holds more; small does the reverse. Changing it places every unit again within its own sector and ring, so due dates keep their meaning, and it undoes like any other change. When a capture or move cannot get full spacing, the log adds `BAND FULL: TRY /ao size large` (or `xl`). The value is stored as `settings.aoSize` (absent means medium). `/sector width` remains the way to widen a single crowded sector.

Pins: moving a dated unit by hand (drag, `/move`, or a sector change) pins it, and auto-advance then skips it. `/unpin <unit>` (or Unpin in the inspector) clears the pin and returns it to the ring its due date gives, in the same sector; the due date is kept. `/due <unit> <date>` also clears the pin.

Command posts: `/cp <unit> main|tac|alt|rear` marks a unit as a headquarters of that type (the HQ staff, with MAIN, TAC, ALT or REAR in place of the icon, in every view); `/cp <unit> none` clears it, restoring its icon. The inspector has the same choice. Suggested meanings: MAIN home base, TAC where you work today, ALT the fallback, REAR errands and logistics.

Clearing orders: `/halt <unit>` cancels all of a unit's own orders, and `/halt <unit> advance|move|attack|axis|link` only that kind (`/stop` and `/cancel` also work); each order in the inspector has a ✕ that does the same for that one order. Undo restores them.

Task forces: a unit becomes a task force (TF bracket) when another unit is attached to it, `/attach <unit> to <tf>`. Only the task force itself may hold orders that cross a sector boundary, e.g. `/attack <tf> <hostile in another sector>`; its attached units may not.

Supporting attacks (`/attack <unit> <hostile> support`, or a second attack dragged onto a hostile that already has a main effort) draw as a thinner arrow with an open head and SPT. Staff and Detail always show them; Commander shows them when their attacker, their target or the main attacker on that target is selected.

Command bar suggestions list units in this order: each command's own grouping first (for example threats first for `/bda`), then the units you last commanded or clicked in this browser tab, most recent first, then units in that unit's sector, then the most recently changed. A unit just captured with `/new` counts as used, and so does clicking a unit that is already selected. The single most recent unit comes before a command's grouping too, except in the attacker slot of `/attack` and `/moving`, which always lists friendlies first. A unit already named in the command goes last, and names that start with what you typed come first. Another user's activity does not change your order.

Support between friendlies: `/support <unit> <engaged unit>` (alias `/spt`) has one friendly back another, in any sector, without a task force. It draws a dashed arrow with an open head and SPT from the supporter to the supported unit (Staff and Detail, or in Commander when either is selected), adds the supporter's weight to the force ratio of the attacks the supported unit makes, and is cleared with `/halt <unit> support` or the inspector's ✕. It is not an attack: the supporter takes no order against the hostile.

Sector HQs as targets: `/advancing <hostile> on sector hq` (its own sector's HQ) or `on <sector> hq`, and `/moving <unit> to sector hq` for a friendly falling back. The targeted sector HQ then shows in every view. Moving the unit to another sector cancels the order; removing the sector drops it, or retargets it to the receiving sector's HQ with `reassign`. Plain `hq` is still the center.

Headquarters of any identity: `/new hostile bn hq "Their legal team" as LEGAL` (or long-press open ground → New hostile HQ), `/attach <unit> to LEGAL` for each unit it controls, and optionally `/cp LEGAL main`. The HQ staff follows the symbol standard, so on a hostile diamond it hangs from the left corner rather than forming a flag. Dashed command lines join attached units to their HQ or task force, in the HQ's color: always in Staff and Detail, and in Commander for the selected HQ or member.

Areas (OBJ, EA, NAI) hold units. `/ea join <name> <unit>…` moves units inside an area and `/ea leave <name> <unit>…` releases them; on the map, drop a unit inside an area's outline to add it and drag it out past the outline to remove it, or pick the area in the unit's inspector. A unit belongs to at most one area, and moving a member to another sector by command takes it out. The outline is centered on its members and grows to enclose them; `/ea size <name> small|medium|large|xl` sets the smallest it draws (medium by default, also on the area's card). Moving an area moves its members with it. The same forms work for `/obj` and `/nai`.

## Vikunja sync

Optional two-way sync with [Vikunja](https://vikunja.io). Set `VIKUNJA_URL` (the Vikunja origin) to turn it on; without it `/vk` is hidden and nothing syncs. The server only ever talks to that origin.

Each user connects their own Vikunja account in the app: user menu (phone: menu) → **Vikunja…**, paste an API token made in Vikunja under Settings → API Tokens (projects, tasks, buckets and webhooks). The server checks it with Vikunja (`GET /user`) before saving and never sends it back; the panel shows only the Vikunja user name. Tokens are encrypted at rest with AES-256-GCM, bound to their user, under a 32-byte key read from `OPSMAP_SECRET_KEY_FILE` (64 hex characters), or created at `DATA_DIR/secrets/master.key` (0600) when unset. The key is not in `opsmap.db` or its nightly backups; keep it with your backups separately, or a restored database will need everyone to paste their token again. A map syncs with the token of the user who bound it; if that user removes their token, `/vk status` says so and syncing stops until they reconnect.

- `/vk bind "Project"` binds the open map (the A/O) to a Vikunja project, found by title or created. Each sector becomes a child project with the sector's name (found or created, and created later for sectors added afterwards). Units of kind unit and event become tasks in their sector's project; persons and places stay on the map, and units already done or dropped are not created. Open tasks already in those projects, and tasks made in Vikunja later, arrive as **pending** units in that sector.
- Synced both ways: title; due date (compared by calendar day in the map's zone); note ↔ description (plain text; HTML from Vikunja is stripped); BDA ↔ progress for hostiles and suspects (60% done = 40% strength; a friendly's strength is capacity, so it is not synced); sector ↔ project (moving a task to another sector project moves the unit); state ↔ kanban bucket: To-Do = todo, Doing = active, Blocked = blocked (bind adds the bucket), Done = done. A task done in Vikunja runs `/done` (a hostile is destroyed); reopening it runs `/reopen`. Tasks in buckets of your own keep their unit's state. A task deleted in Vikunja drops its unit; a unit dropped in opsmap marks its task done. A task that still exists is never treated as deleted: moved to a project outside the A/O (or left in a removed or archived sector's project), it goes back to its unit's sector. Binding links an open, unlinked task with the same title in the same sector project instead of creating a second one, so unbinding and binding again does not duplicate anything. One task or unit that fails (a Vikunja error) does not stop the others; `/vk sync` and `/vk status` name it.
- Identity ↔ labels: each task carries one identity label, `hostile`, `suspect`, `friendly`, `assumed`, `neutral`, `unknown` or `pending` (`enemy` and `friend` are read too). Labels are matched by title ignoring case and created, colored like the frames, on first use; other labels are left alone. Setting one in Vikunja runs `/id`; `/id` swaps the label. A task with no identity label gets its unit's; one with several keeps opsmap's identity and loses the extras. A task made in Vikunja with an identity label arrives with that identity instead of pending.

Each field merges three ways against the values both sides last agreed on: changed on one side, it is copied across; changed on both, the newer change wins. Changes from Vikunja are logged as `VIKUNJA: …` by the system with via `vikunja`.
- opsmap pushes about a second after each change. Vikunja changes arrive through webhooks that opsmap manages itself: one per sector project (`task.created`, `task.updated`, `task.deleted`) posting to `PUBLIC_URL/api/vikunja/hook/<map>`, signed with a per-map secret (HMAC-SHA256 in `X-Vikunja-Signature`; unsigned or wrongly signed deliveries get 401). Bind registers them; they are checked every 10 minutes and at once on `/vk sync` or a sector change, and a webhook deleted or altered in Vikunja is made again; unbinding or deleting the map removes them. `/vk status` shows how many are registered and the last delivery. Webhooks need `PUBLIC_URL` to be an address Vikunja can reach (not loopback), and Vikunja refuses private addresses, tailnet ones included, unless it runs with `VIKUNJA_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS=true`. The server also polls: every minute, or every 5 minutes while webhooks are being delivered.
- `/vk status` reports the binding and the last sync or error, `/vk sync` syncs now, `/vk unbind` stops syncing (tasks stay in Vikunja; its webhooks are removed). The bind is recorded by the system, so `/undo` does not reverse it; `/vk unbind` does. Who bound a map is kept on the server, not in the map document: an imported or new map never carries a binding (export, import and duplicate drop it), so no document can make the server use someone's token. The inspector links each synced unit to its task. MCP `opsmap_command` takes the same `/vk` text.
- `/reopen <unit>` (any map) returns a done or dropped unit to To do.

## Multiple maps

The server holds any number of shared maps (up to 50). Each map has its own op journal, sequence numbers, snapshots, undo history, presence and 04:00 morning turn; users, sessions, tokens and backups are shared, and everything stays in the one `opsmap.db`. The first map in creation order is the default. Upgrading an existing database moves its journal into the map `main`, named "Main", without changing it.

The top-bar **Map** button (the phone menu's Map section) lists the maps and opens one, and creates a new empty map (five standard sectors), duplicates the open map, creates one from an exported JSON file, or renames the open map. Any signed-in user can do these; only an administrator can delete a map, and the last map cannot be deleted. Deleting a map removes its journal (nightly backups keep earlier copies) and moves anyone on it to the default map. The open map is in the address bar as `?map=<id>` (absent for the default map) and is remembered per browser in `localStorage` under `opsmap.ui.map`. Switching waits until this map's pending changes are saved.

HTTP: `GET /api/maps`, `POST /api/maps {name, doc?}`, `PATCH /api/maps/:id {name}`, `DELETE /api/maps/:id` (admin). Writes require the app's own `Origin`. `GET /api/export` and admin `POST /api/import` take `?map=<id or name>` and use the default map without it. The WebSocket `hello` carries `map`; the `welcome` names the map served and lists all maps, and a `maps` frame announces creations, renames and deletions.

MCP: `opsmap_maps` lists the maps. `opsmap_command`, `opsmap_query` and `opsmap_sitrep` take an optional `map` (id, or name ignoring case) and use the default map without it.
