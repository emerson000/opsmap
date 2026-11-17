# Task sync

Optional two-way sync between a map and a task service. Two services are built in: [Vikunja](vikunja.md) (`VIKUNJA_URL`) and [Asana](asana.md) (`ASANA_SYNC=1`). This page describes what works the same for every service; each service's page lists its own fields, setup and limits. Without a configured service, `/tasks` and the service aliases are hidden and nothing syncs.

## Accounts and tokens

- Each user connects their own account for each service: user menu (phone: menu) → **Vikunja…** or **Asana…**, then paste a token. The server checks the token with the service before it saves it and never sends it back; the panel shows only the user name the service gave. The HTTP API is `GET`, `PUT {token}` and `DELETE /api/tasksync/‹service›/account` (signed-in, same-origin).
- Tokens are encrypted at rest with AES-256-GCM and bound to their user and service, so a value copied to another user or service does not open. The 32-byte key is read from `OPSMAP_SECRET_KEY_FILE` (64 hex characters), or created at `DATA_DIR/secrets/master.key` (0600) when unset. The key is not in `opsmap.db` or its nightly backups. Keep it with your backups separately, or a restored database will need everyone to paste their token again.
- A map syncs with the token of the user who bound it. If that user removes their token, `/tasks status` says `(no token: connect it in the menu → ‹Service›)`, and the map is not synced until they reconnect. Another user binding the same map gets `Bound by ‹name›: they sync it with their ‹Service› account`.
- Who bound a map is kept on the server, not in the map document. Export, import, a new map and a duplicate never carry a binding, so no document can make the server use someone's token.

## Binding

- `/tasks bind "Project"` binds the open map (the A/O) to a project in the service. With more than one service on the server, name it: `/tasks bind asana "Project"`. Each service also has an alias that works as the verb: `/vk bind "Project"`, `/asana bind "Project"`. The aliases come from the server, so `/help vk` and `opsmap_help` show only the services this server has. A project can also be given by its URL; each service page says how a name is matched.
- Each sector becomes a container in the project: a child project in Vikunja, a section in Asana. It has the sector's name, is found by name or created, and is created later for sectors added afterwards. A container keeps its name when its sector is renamed.
- Units of kind unit and event become tasks in their sector's container. Persons and places stay on the map, and units already done or dropped are not created. Open tasks already in those containers, and tasks made in the service later, arrive as **pending** units in that sector (or with the identity they carry).
- Binding links an open, unlinked task with the same title in the same container (or under the same parent task) instead of creating a second one, so unbinding and binding again does not duplicate anything.
- A map has one binding. Binding a bound map to another project or service answers `Bound to ‹Service› project ‹title›: /tasks unbind first`. Binding again to the same project is allowed.
- The bind is recorded by the system, so `/undo` does not reverse it; `/tasks unbind` does. Unbinding stops syncing and removes the map's webhooks; the tasks stay in the service.

## How changes merge

- Each field merges three ways against the values both sides last agreed on: changed on one side, it is copied across; changed on both, the newer change wins.
- opsmap pushes about a second after each change. Changes from the service are logged by the system as `‹SERVICE›: …`, with via set to the service, and new units as `‹SERVICE› NEW ‹designation›`.
- A task done in the service runs `/done` (a hostile is destroyed); reopening it runs `/reopen`. A unit dropped in opsmap marks its task done. A task deleted in the service drops its unit.
- A task that still exists is never treated as deleted. Moved to a container outside the A/O, or left in a removed sector's container, it goes back to its unit's sector.
- One task or unit that fails (an error from the service) does not stop the others; `/tasks sync` and `/tasks status` name it.
- Only the fields a service declares are synced. A service without progress never receives BDA, and nothing it does changes BDA. A service without relations gets no link orders, and `/link` makes no calls to it.

## Containers that are not sectors

A container in the project that matches no sector (for example a section `Home`) is not synced: its tasks stay off the map, and `/tasks status` lists it with its open tasks, `not synced: section Home (2 tasks)`. A linked task moved into such a container goes back to its unit's sector. A sector whose container is archived in the service is frozen until it is unarchived; status lists it.

## Task forces and subtasks

A unit attached to a task force (`/attach`, `/reinforce … with`) is a subtask of the task force's task, in every service that has subtasks.

- A task force's task is made before its members, and a member is made as its subtask.
- A subtask added in the service under a linked task arrives as a unit in the parent unit's sector and runs `/attach`. Moving it to another parent re-attaches it; making it top-level runs `/detach`.
- A subtask under a task that is not linked (or outside the project) is ignored.
- A subtask's own container is never pulled: it follows its task force. How a service stores a subtask, and what happens when its parent is deleted, is on that service's page.
- An attachment from the service that opsmap cannot take, such as one that would make a cycle, is reported once by `/tasks sync` and left in the service. opsmap keeps its own attachment and does not push it back.
- Completing a task force's task in the service makes its unit done. The attached units keep their own state.

## Field switches

`/tasks field ‹identity|state|due|note|progress› off` stops syncing that field on this map, and `on` turns it back on (log `ASANA IDENTITY SYNC OFF` / `… ON`, with the bound service's name; `/undo` reverses it). `/tasks bind "Project" without identity,state` binds with those fields already off. The sidebar shows one switch for each field the bound service syncs, and the bind form has one checkbox for each.

- While a field is off, it is neither pushed nor pulled: opsmap keeps its value, and the task keeps whatever it has.
- Use `identity` off when the tasks are shared with other people or projects and opsmap's classification (hostile, suspect, …) must stay out of them. Turning `identity` off makes the next sync remove, once, the identity tags or labels that opsmap wrote to linked tasks. Identity tags or labels that someone set in the service (on a task made there, or on a task opsmap linked by its title) are left alone, and so are all other tags and labels. While it is off, new tasks get no identity, and tasks made in the service arrive as pending with their tags ignored.
- Turning a field back on pushes opsmap's value once; the value the task had while the field was off does not come back.
- `/tasks status` lists the fields that are off: `not synced: identity, state`. Every field is on by default.

## How changes arrive

Polling always runs, and sync is correct without any webhook. Webhooks only bring a sync forward. For each bound map the server picks a delivery mode, shows it in `/tasks status` and in the sidebar, and checks it again every 10 minutes and on `/tasks sync`:

| Mode | When | Polls every | `/tasks status` shows |
|---|---|---|---|
| off | `TASKSYNC_WEBHOOKS=off`, `PUBLIC_URL` unset or loopback, or `PUBLIC_URL` not good enough for the service (Asana needs a public HTTPS address) | poll interval | `polling every 2 minutes (webhooks off: Asana needs a public HTTPS address; PUBLIC_URL is a private name (.ts.net))` |
| pending | webhooks registered, no signed delivery in the last 15 minutes | poll interval | `1 webhook, none delivered yet · polling every 2 minutes` |
| live | a signed delivery (or Asana heartbeat) in the last 15 minutes | idle interval | `1 webhook · last delivery 12:00:00Z` |
| failed | the service refused to register the webhooks, or its handshake did not arrive in time | poll interval | `webhooks failed: ‹reason›, retrying at 12:10:00Z · polling every 2 minutes` |

- The intervals are each service's: Vikunja polls every minute (every 5 minutes when live), Asana every 2 minutes (every 10 minutes when live). `TASKSYNC_POLL_SECONDS` overrides the poll interval for every service (15 seconds at least; for development).
- When webhooks delivered before but nothing has come for 15 minutes, the map is pending again, and status adds ` · polling every minute` (or `2 minutes`) after the last delivery: `5 webhooks · last delivery 18:22:59Z · polling every minute`.
- A failed registration is tried again after 10 minutes, then less often, up to every 6 hours, and at once on `/tasks sync`. A webhook deleted or turned off in the service is made again at the next check.
- While webhooks are not live, opening the map in a browser, coming back to its browser tab, or an MCP command or read on it pulls within about 2 seconds (at most once every 20 seconds per map).
- `TASKSYNC_WEBHOOKS=on` registers webhooks even when `PUBLIC_URL` looks private, for a service on the same machine or LAN. `PUBLIC_URL` is resolved when the server starts and every hour; it counts as private when it resolves to a loopback, private (RFC 1918), CGNAT (`100.64.0.0/10`, which includes Tailscale), link-local or IPv6 unique-local address, or when its name ends in `.local`, `.lan`, `.internal`, `.home.arpa` or `.ts.net`. [Operations](operations.md#running-on-a-lan-or-as-a-dev-server) has more on LAN and development servers.

### The webhook endpoint

- Deliveries post to `PUBLIC_URL/api/tasksync/‹service›/hook/‹map›` (Vikunja keeps its older path, see its page). Each map has its own secret, and each service signs its deliveries; an unsigned or wrongly signed delivery gets 401 and changes nothing. A delivery to a map that is not bound to that service gets 401 too.
- A request body is at most 64 KiB.
- Refused requests are limited, per map (60 at once, then 5 a second) and per client address (200 at once, then 20 a second). Accepted deliveries are never counted. Once a limit is used up, the server answers 429 without reading the body, unless the request's URL already shows it is genuine (Asana's per-webhook nonce). Vikunja's URLs carry no such proof, so during a flood of forged requests Vikunja's real deliveries get 429 as well, and its changes arrive by polling until the flood stops. Behind a reverse proxy the per-address limit sees the proxy's address, so it works as one limit for the whole server.

## Commands and hints

- `/tasks status` reports the binding, who syncs it, the sectors and linked units, the fields that are off, the delivery mode, the last sync and the last error. `/tasks sync` syncs now. `/tasks unbind` stops syncing. Each works with the service's alias too (`/vk status`, `/asana sync`).
- Users may submit `/tasks unbind` and `/tasks field …` as changes; bind, sync and status are requests that the server answers.
- `/tasks sync` or `/tasks status` on an unbound map answers `This map is not bound to a task service: /tasks bind "‹project›"`. Other hints: `Vikunja project Ops is gone: /tasks unbind`, `This map was not bound on this server: /tasks unbind, then /tasks bind`. An alias names its service: on a map bound to another service, `/asana unbind` (or `sync`, `status`, `field`) answers `Bound to … /tasks unbind first`.
- MCP `opsmap_command` takes the same `/tasks` text and gives the same answers ([MCP](mcp.md)).
- The inspector links each synced unit to its task, and each synced sector to its container when the service has a link for one.

## Upgrading from a server that synced only with Vikunja

On its first start, the server moves the sync's links, webhook state and tokens into the provider-neutral tables once, and rewrites each stored snapshot in the new shape, in one transaction. Snapshots are kept, not cleared: an old journal may not replay from the start, so each map still starts from its latest snapshot and replays only the later steps (old `vk` steps run as `/tasks` ones). A snapshot that does not convert stops the move, and nothing changes.

- `DATA_DIR=… npx tsx server/cli.ts tasks migrate --dry-run` (in the container: `node dist/server/cli.js tasks migrate --dry-run`) prints what the move will do, one line per map: `map main: snapshots 503 ok, 537 ok, 600 ok; bound to Vikunja project 39; 12 units linked, 12 in the document; 1 tokens`. It does not move anything, but it opens the database with the server's normal schema setup, which can add tables or columns to an older database. Run it on a copy.
- Tokens are copied only when the secret key file is present. Without it, `tasks migrate` says so, and the tokens are copied when the server starts with the key.
- Browser tabs opened before the upgrade do not know the new messages: `/tasks` and the Task sync section work after the tab reloads.
- [Operations](operations.md#upgrading-to-provider-neutral-task-sync) lists the deploy steps.

## Adding a provider

A task service is an adapter behind one contract. The engine (`server/tasksync/`) does binding, merging, scheduling, delivery modes and status for every service; it never names one. `tests/architecture.test.ts` fails if a service's name appears outside `server/providers/` (and the legacy translation and migration).

1. **The contract** is `server/tasksync/contract.ts`. A `TaskProvider` has a `descriptor` (id, label, aliases, the nouns for its project and container, token help, URL templates with `{root}`, `{container}` and `{id}`), `capabilities` (the neutral fields it syncs: `title`, `due`, `note`, `progress`, `status`, `container`, `affiliation`, `parent`; the relation kinds; limits; webhook requirements; poll intervals), `verify(token)` and `connect(token)`. The `ProviderSession` from `connect` finds or creates the root, ensures one container per sector, reads a `snapshot` (every task in the root, children included, open or done in the last 7 days), and gets, creates and updates tasks. Webhooks are optional: `ensureWebhooks`, `removeWebhooks`, `receiveWebhook` and `preverify`. Throw `RateLimited(retryAfterS)` on a rate limit and `RemoteAuthError` on a refused token.
2. **The factory line.** Put the adapter in `server/providers/‹id›/`, export a `ProviderModule` (`{ id, factory }`) whose factory reads its own environment variables and returns the provider or `undefined`, and add it to `MODULES` in `server/providers/index.ts`. Nothing else in the server changes: the welcome message carries the descriptor, and the UI, the grammar, the aliases and MCP read it from there.
3. **A fake.** Write an in-memory fake of the service's API in `tests/server/providers/`, as `fake-asana.ts` and `fake-vikunja.ts` do, so the adapter runs in tests without the network. Pin the fake to what the real service does (`fake-asana.test.ts`). `server/providers/fake/provider.ts` is a fake of the whole contract that the engine tests and the e2e suite use (`OPSMAP_FAKE_PROVIDER=1` under `NODE_ENV=test`).
4. **`providerContract`.** Call `providerContract(name, make)` from `tests/server/provider-contract.ts` with your provider over its fake. It checks the behaviors the engine relies on for any service. Then add engine tests over the fake for the service's own mapping, and, if you can, an opt-in live test like `tests/live/asana-live.test.ts`.
5. **Docs.** Add `docs/‹id›.md` with setup, the field table and what is not synced, and list the service's variables in [Operations](operations.md).
