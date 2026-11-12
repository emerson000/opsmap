# AGENTS.md

Rules for coding agents working in this repository. `README.md` is the overview; the manual is in `docs/` (`user-guide.md`, `mcp.md`, `vikunja.md`, `operations.md`). Read the part for the area you change.

## Project layout

- `src/core/` — the shared model and command language. It runs in the browser and on the server.
  - `commands/syntax.ts`: `VERBS`, `aliases` and `SYNTAX`.
  - `commands/grammar.ts`: `parse()`, which turns slash-command text into a `Command`.
  - `commands/apply.ts`: `apply(doc, command, now)`, the only code that changes a map document.
  - `commands/suggest.ts`: command bar autocomplete.
- `src/lib/` — the Svelte 5 client: `ui/` (command bar, inspector sidebar, sheet, top bar), `map/` (SVG map, gestures, menus), `commands/` (client dispatch, undo, recent units), `sync/` (WebSocket client).
- `server/` — Hono HTTP server, WebSocket hub (`hub.ts`), maps (`maps.ts`), MCP server (`mcp.ts`), Vikunja sync (`vikunja/`).
- `tests/` — Vitest unit tests. `e2e/` — Playwright browser tests.

## Commands

```bash
npm test          # unit tests (Vitest)
npm run check     # svelte-check and tsc
npx playwright test   # browser tests; run `npx playwright install` once
npm run build && npm run dev:server   # run locally on http://127.0.0.1:8080 (users alice, bob)
```

Run `npm test` and `npm run check` before every commit. Run the Playwright tests when you change the UI.

## One command language

Every change to a map is a `Command` (`{ verb, args }`) that goes through `apply()` in `src/core/commands/apply.ts`. The command bar, the MCP server, the sidebar, menus, cards and map gestures are only different ways to build that `Command`.

1. Do not change a map document anywhere except in `apply()`. UI code calls `run()` or `dispatch()` with a `Command`; server code calls `hub.submit()`.
2. A new capability starts in the grammar: add the verb or argument to `VERBS` and `SYNTAX`, parse it in `parse()`, apply it in `apply()`, and add its autocomplete to `suggest.ts`. Then add the UI and MCP surfaces described below. Do not add a capability that only one surface can reach.
3. A UI control builds the same `Command` that `parse()` returns for the equivalent text, with the same argument names and values. Do not write a second code path with different rules, limits or log text.

## Parity: MCP and the command bar

The command bar and the MCP server must be able to do the same things.

1. Every verb and argument form that the command bar accepts must work through the MCP `opsmap_command` tool with the same text. It must give the same result, the same log line and the same error message.
2. A verb that the browser handles itself (for example `view`, `find`, `export`, `import`, `sitrep copy`, `help`) must have a documented MCP equivalent that returns the same information. List such verbs in `CLIENT_ONLY` in `server/mcp.ts`, with the MCP behavior next to each. The parity test reads that list.
3. Context that the command bar gets from the browser (the selected unit, which resolves ambiguous names and `sector hq`; the open map) must also be something an MCP caller can supply as an argument (`selected` and `map` on `opsmap_command`).
4. Anything an MCP tool can do that is not a command (listing maps, querying units, map management) must also be possible in the browser, in the command bar or in the UI. Anything the browser can do outside the command bar (create, rename, duplicate or delete a map) must have an MCP tool with the same permission rules as the HTTP API.
5. `tests/server/mcp-parity.test.ts` must pass. It sends the same text through the command bar path and through `opsmap_command` and compares the log, the error and the resulting document. When you add a verb, extend that test; do not add the verb to the client-only list to make the test pass unless the browser really must handle it.
6. Update `docs/mcp.md` and the `SYNTAX` text when a command changes. `opsmap_help` serves `SYNTAX` to agents.

## Parity: the sidebar, menus and the command bar

The sidebar (the inspector: a column on desktop and tablet, the bottom sheet on phones) must be able to do everything the command bar can do to the object that is open in it.

1. Every map object has a sidebar view: units, areas (OBJ, EA, NAI), phase lines (PL) and sectors. Selecting an object on the map, in a list, or with `/find`, opens its view.
2. Every verb and every option that acts on an object must be reachable from that object's sidebar view. This includes enum choices (identity, echelon, function, ring, condition, command post, link kind, attack role, halt kind) and flags such as `planned`, `bypassed`, `confirm`, `with`, `support` and `via`. A verb that needs a second object (attack, link, attach, support, axis, join) needs a picker in the sidebar, or a button that fills the command bar with the command for the user to finish.
3. The right-click unit menu, the area card and other quick menus are shortcuts. Everything in them must also be in the sidebar, and each item must run or fill the same command.
4. Show the equivalent command for each sidebar control (in its tooltip or label), so that users learn the command bar from the UI.
5. Relationships show on both ends. A unit shows its orders, area, task force and supporters; an area shows its members and the orders and axes that target it; a phase line shows the axes that pass through it.
6. When you add a verb or option, add its sidebar control in the same change, and add or update a Playwright test that uses the control.

## UI work

- Phones (below 760 px wide), tablets (760 to 1279 px) and desktop have different layouts. Check all three when you change the UI. `docs/user-guide.md` describes the touch gestures and the phone sheet; do not break them.
- Keep the existing `data-testid` values or update the e2e tests that use them.
- Day and Night themes both must work. Use the CSS variables, not fixed colors.
- For a major UI change, get an independent design review before you merge.

## Code style

- Match the style of the file you edit. Files in `src/core/` and `server/` are dense one-line TypeScript; Svelte components are formatted normally.
- TypeScript strict mode. No new runtime dependencies without a reason in the commit message.
- Write user-facing text in plain US English.
- Commit messages: a short imperative subject line in sentence case, like the existing history.

## Local MCP

Create a token for local testing in the browser (sign in as alice, then **Access tokens…** in the user menu) or with `DATA_DIR=.data npx tsx server/cli.ts token create --name <agent> --user alice@dev.local`. `docs/mcp.md` shows how to connect Claude Code and Codex. The MCP endpoint is `POST /mcp` with the token as a bearer token. Do not commit tokens or the `.data` directory.
