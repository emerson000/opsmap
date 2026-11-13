# MCP and HTTP API

`POST /mcp` with `Authorization: Bearer <token>` (stateless Streamable HTTP, JSON responses). Every write is attributed to the token's user, with the token name beside their initials, and each token has its own undo history.

Token names can be reused after revocation; the new token has a separate undo history.

## Tools

- `opsmap_command {text, map?, selected?}` runs the same text as the command bar, through the same parser and core, and returns the same log line (`{ok:true, log}`) or the same error (`{ok:false, error, at}`). `map` is an id or a name (ignoring case); without it, the default map. `selected` is a unit (designation, title or id) to treat as selected, as a click does in the browser: an unclear unit name prefers the selected unit's sector (`/bda sin 50%` with two units named "…sink…"), and `/new` without `in <sector>` captures in its sector.
- Commands the browser handles itself answer with their content instead: `/find` returns `unit` (or `measure` for `/find obj|ea|nai|pl <name>`, `sector` for `/find sector <name>`), `/sitrep` (and `/sitrep copy`) `text`, `/export` the map as `doc`, `/help [verb]` `syntax`, `/map` the list of maps and `/map <name>` that map (MCP has no open map: pass `map` to the other tools). `/view` is refused (it is each browser's display setting). `/turn` is refused as in the browser (the server runs the morning turn). `/import` points administrators to `opsmap_import`. `/undo` and `/redo` act on the token's own changes and return the revert's log line. The list, with what each does, is `CLIENT_ONLY` in `server/mcp.ts`; a test fails when a verb is added without syntax, autocomplete and either MCP handling or an entry there.
- `opsmap_maps` lists the maps (the first is the default). `opsmap_query {map?, sector?, affiliation?, lifecycle?, ring?, text?}` lists units (with `tf` for the task force a unit is attached to, and `taskForce` and `collapsed` on a task force), `opsmap_sitrep {map?}` gives the SITREP and `opsmap_help {verb?}` the grammar (aliases and a leading `/` are accepted).
- Order verbs work as in the bar, including ring targets and withdrawals: `/withdraw LEAK to far`, `/moving RSP to mid` and `/advancing LEAK on near` give the same log line and the same errors (`Use /withdraw to move LEAK away from HQ`).
- Map management, with the HTTP API's rules: `opsmap_map_create {name?, from?, doc?}` creates an empty map, a copy of the map `from` (named "<name> copy" unless `name` is given; its Vikunja binding is not copied) or a map from an exported `doc`. The others are `opsmap_map_rename {map, name}` and `opsmap_map_delete {map}` (administrator; the last map cannot be deleted). `opsmap_import {map?, doc}` (administrator) replaces a map's contents, like `/import` in the browser, and `/undo` reverses it. A request is at most 128 KB, so larger documents go through `POST /api/maps` or `POST /api/import`.
- Tokens: `opsmap_tokens` lists active tokens (your own, or everyone's for an administrator) and `opsmap_token_revoke {token}` revokes one by id or name. Create tokens in the browser or with the server CLI (see [Tokens](#tokens)).

## Tokens

Every MCP request carries a bearer token. A token acts as the user who created it.

### Create a token in the browser

1. Sign in. This works the same with OIDC and with the development users (alice, bob) of a local server.
2. Open **Access tokens…**: in the user menu on desktop, or in **Menu** on tablets and phones.
3. Type a name for the agent that will use the token (1 to 60 characters, unique among active tokens) and select **Create**.
4. Copy the token. The server keeps only a hash of it, so it is not shown again. The panel also shows the endpoint and ready-to-paste setup for Claude Code and Codex, with the token filled in.

The panel lists your active tokens with when each was created and last used. **Revoke**, then **Confirm revoke**, stops a token at once. An administrator sees and can revoke every user's tokens, to cut off a lost or leaked token. Nobody can create a token for another user in the browser.

The same rules apply over HTTP (same-origin JSON requests from a signed-in session): `GET /api/tokens` lists, `POST /api/tokens {name}` creates and returns `token` once, and `DELETE /api/tokens/:id` revokes.

Over MCP, `opsmap_tokens` lists the same tokens (with `current` on the one making the call) and `opsmap_token_revoke {token}` revokes one by id or name. MCP cannot create tokens: a leaked token must not be able to make new ones that outlive its revocation.

### Create a token on the server

An operator can create tokens from a shell. The user must have signed in at least once.

```bash
DATA_DIR=.data npx tsx server/cli.ts token create --name <agent> --user <email>   # from a checkout
docker exec opsmap node dist/server/cli.js token create --name <agent> --user <email>   # in the container
```

`token list` shows all tokens, including revoked ones, and `token revoke <id or name>` revokes one.

### Connect Claude Code

```bash
claude mcp add --transport http opsmap https://opsmap.example.com/mcp \
  --header "Authorization: Bearer <token>"
```

Add `--scope user` to make the server available in every project, or `--scope project` to write it to `.mcp.json` (keep the token out of a shared file: put it in an environment variable and write `"Authorization": "Bearer ${OPSMAP_TOKEN}"` there). `claude mcp list` checks the connection; in a session, `/mcp` shows the server and its tools.

### Connect Codex

Put the token in an environment variable, for example in your shell profile:

```bash
export OPSMAP_TOKEN=<token>
```

Then add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.opsmap]
url = "https://opsmap.example.com/mcp"
bearer_token_env_var = "OPSMAP_TOKEN"
```

Restart Codex. In a session, `/mcp` lists the server and its tools.

### Local development server

1. Start the server: `npm run build && npm run dev:server`. It listens on http://127.0.0.1:8080 with the development users alice (administrator) and bob, and keeps its data in `./.data`.
2. Open http://127.0.0.1:8080, sign in as alice or bob, and create a token under **Access tokens…** as above. Or, after that user has signed in once:

   ```bash
   DATA_DIR=.data npx tsx server/cli.ts token create --name local-agent --user alice@dev.local
   ```

3. Use `http://127.0.0.1:8080/mcp` as the URL:

   ```bash
   claude mcp add --transport http opsmap-local http://127.0.0.1:8080/mcp --header "Authorization: Bearer <token>"
   ```

   ```toml
   [mcp_servers.opsmap-local]
   url = "http://127.0.0.1:8080/mcp"
   bearer_token_env_var = "OPSMAP_LOCAL_TOKEN"
   ```

With `npm run dev`, the Vite server on http://localhost:5173 forwards `/mcp` to the server, so `http://localhost:5173/mcp` also works while it runs. Tokens live in the database in `DATA_DIR`: deleting `.data` deletes them. Do not commit tokens or the `.data` directory.

### Check a token

```bash
curl -s http://127.0.0.1:8080/mcp -H "Authorization: Bearer <token>" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"opsmap_maps","arguments":{}}}'
```

A revoked or unknown token gets `401 Valid bearer token required`. Each token may make about 20 requests per second.

## HTTP API for maps

HTTP: `GET /api/maps`, `POST /api/maps {name, doc?}`, `PATCH /api/maps/:id {name}`, `DELETE /api/maps/:id` (admin). Writes require the app's own `Origin`. `GET /api/export` and admin `POST /api/import` take `?map=<id or name>` and use the default map without it. The WebSocket `hello` carries `map`; the `welcome` names the map served and lists all maps, and a `maps` frame announces creations, renames and deletions.
