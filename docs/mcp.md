# MCP and HTTP API

`POST /mcp` with `Authorization: Bearer <token>` (stateless Streamable HTTP, JSON responses). Every write is attributed to the token's user, with the token name beside their initials, and each token has its own undo history.

Token names can be reused after revocation; the new token has a separate undo history.

## Tools

- `opsmap_command {text, map?, selected?}` runs the same text as the command bar, through the same parser and core, and returns the same log line (`{ok:true, log}`) or the same error (`{ok:false, error, at}`). `map` is an id or a name (ignoring case); without it, the default map. `selected` is a unit (designation, title or id) to treat as selected, as a click does in the browser: an unclear unit name prefers the selected unit's sector (`/bda sin 50%` with two units named "…sink…"), and `/new` without `in <sector>` captures in its sector.
- Commands the browser handles itself answer with their content instead: `/find` returns `unit` (or `measure` for `/find obj|ea|nai|pl <name>`, `sector` for `/find sector <name>`), `/sitrep` (and `/sitrep copy`) `text`, `/export` the map as `doc`, `/help [verb]` `syntax`, `/map` the list of maps and `/map <name>` that map (MCP has no open map: pass `map` to the other tools). `/view` is refused (it is each browser's display setting). `/turn` is refused as in the browser (the server runs the morning turn). `/import` points administrators to `opsmap_import`. `/undo` and `/redo` act on the token's own changes and return the revert's log line. The list, with what each does, is `CLIENT_ONLY` in `server/mcp.ts`; a test fails when a verb is added without syntax, autocomplete and either MCP handling or an entry there.
- `opsmap_maps` lists the maps (the first is the default). `opsmap_query {map?, sector?, affiliation?, lifecycle?, ring?, text?}` lists units, `opsmap_sitrep {map?}` gives the SITREP and `opsmap_help {verb?}` the grammar (aliases and a leading `/` are accepted).
- Map management, with the HTTP API's rules: `opsmap_map_create {name?, from?, doc?}` creates an empty map, a copy of the map `from` (named "<name> copy" unless `name` is given; its Vikunja binding is not copied) or a map from an exported `doc`. The others are `opsmap_map_rename {map, name}` and `opsmap_map_delete {map}` (administrator; the last map cannot be deleted). `opsmap_import {map?, doc}` (administrator) replaces a map's contents, like `/import` in the browser, and `/undo` reverses it. A request is at most 128 KB, so larger documents go through `POST /api/maps` or `POST /api/import`.

## Tokens

Create a token on the server and pass it as the bearer token:

```bash
DATA_DIR=.data npx tsx server/cli.ts token create --name <agent> --user <email>   # from a checkout
docker exec opsmap node dist/server/cli.js token create --name <agent> --user <email>   # in the container
```

`token list` and `token revoke <name>` manage them.

## HTTP API for maps

HTTP: `GET /api/maps`, `POST /api/maps {name, doc?}`, `PATCH /api/maps/:id {name}`, `DELETE /api/maps/:id` (admin). Writes require the app's own `Origin`. `GET /api/export` and admin `POST /api/import` take `?map=<id or name>` and use the default map without it. The WebSocket `hello` carries `map`; the `welcome` names the map served and lists all maps, and a `maps` frame announces creations, renames and deletions.
