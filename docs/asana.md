# Asana sync

Optional two-way sync with [Asana](https://asana.com). Set `ASANA_SYNC=1` (or `true`) to turn it on; without it the `asana` service and the `/asana` alias are hidden. It works on Asana's free plan. Binding, merging, field switches, delivery modes and the `/tasks` commands work as [Task sync](task-sync.md) describes; this page covers what is specific to Asana.

## Setup

1. Start the server with `ASANA_SYNC=1`. For instant updates, `PUBLIC_URL` must be a public HTTPS address that Asana can reach (see [Webhooks](#webhooks)). Without one, the server polls.
2. Each user creates a personal access token in Asana (My settings → Apps → Developer apps) and pastes it under user menu (phone: menu) → **Asana…**. The server checks it with `GET /users/me`, stores it encrypted, and shows the Asana user name. A map syncs with the token of the user who bound it, so that user must be able to see the project.
3. Bind the map: `/tasks bind asana "Ops"` (or `/asana bind "Ops"`, or `/tasks bind "Ops"` when Asana is the only service). The project is found by name, ignoring case, in every workspace the token can see; a live project wins over an archived one. Several matches answer `Several Asana projects named Ops: ‹gid›, ‹gid›`; bind by URL instead. With no match, the project is made in the token's only workspace; with several workspaces the answer is `Several Asana workspaces: bind by project URL`. A project URL (`https://app.asana.com/0/‹project›/…` or `https://app.asana.com/1/‹workspace›/project/‹project›/…`) or a project gid binds that project.
4. Each sector becomes a section of the project with the sector's name (matched ignoring case, made when missing). Sections that are no sector's, such as `Home`, are left alone: their tasks stay off the map, and `/tasks status` lists them (`not synced: section Home (1 task)`).

`/tasks status` reads, for example, `ASANA: bound to Ops (https://app.asana.com/0/‹project›) by Alice · 5 sectors · 12 units linked · polling every 2 minutes (webhooks off: Asana needs a public HTTPS address; PUBLIC_URL is a private name (.ts.net)) · last sync 12:00:00Z · not synced: section Home (1 task)`. The inspector links each unit to its task (`Asana task ↗`).

## What syncs

| opsmap | Asana | Notes |
|---|---|---|
| Title | Name | Up to 1,024 characters. |
| Due date | Due date (`due_on`) | Compared by calendar day in the map's zone. A due time (`due_at`) is read as its day, and the exact time comes through to the unit. Writing a day sets `due_on`, which clears the time. |
| Note | Description (`notes`) | Plain text, up to 16,000 characters. A longer description stays as it is in Asana while its start matches the note. |
| Done | Completed | Completing a task runs `/done` (a hostile is destroyed); marking it incomplete runs `/reopen`. A unit dropped in opsmap completes its task. A task deleted in Asana drops its unit, and so does a task the token can no longer open (Asana answers 403, for example after the task moved into a private project). This still syncs with `state` off. |
| State | Tags `doing` and `blocked` | Neither tag: to do. `doing`: active. `blocked`: blocked. Setting one removes the other. Both: opsmap keeps the unit's state, and its next change settles the tags. With `state` off, opsmap neither reads nor writes these tags. |
| Sector | Section | Moving a task to another sector's section moves its unit. Moved to a section that is no sector's, it goes back. |
| Identity | Tags `hostile`, `suspect`, `friendly`, `assumed`, `neutral`, `unknown`, `pending` | One per task. `enemy`, `friend` and `assumed friend` are read too. Setting one in Asana runs `/id`; `/id` swaps the tag. Other tags are left alone. |
| Task force | Subtasks | See [Subtasks](#subtasks). |

- Tags are found by name, ignoring case, in the project's workspace, and made on first use in Asana's colors closest to the frames: `hostile` light red, `suspect` light orange, `friendly` light blue, `assumed` light teal, `neutral` light green, `unknown` light yellow, `pending` light warm gray, `doing` dark blue and `blocked` dark red. Asana accepts only its own color names.
- **Asana tags belong to the whole workspace.** Everyone in the workspace can see a tag such as `hostile` in tag search and on any task they can open. If the workspace is shared with colleagues and opsmap's classification should stay private, bind with `without identity` or turn it off with `/tasks field identity off` ([Field switches](task-sync.md#field-switches)). Turning it off removes the identity tags opsmap put on linked tasks; it does not delete the tags from the workspace. Delete those in Asana if you want them gone.
- A done task keeps its `doing` or `blocked` tag. When it is marked incomplete in Asana, its unit returns active (or blocked) rather than to do. With `state` off it returns to do.
- Not synced: BDA (strength) and link orders, because Asana's percent fields and dependencies need a paid plan; assignees, followers, start dates, comments, attachments and custom fields; sections in other projects; tasks in sections that are no sector's; subtasks of tasks that are not linked; and subtasks more than 5 levels below a top-level task.

## Subtasks

A unit attached to a task force is a subtask of the task force's task.

- opsmap makes a member as a plain subtask: it has the parent and no project of its own. Attaching a unit whose task is top-level makes it a subtask and takes it out of the project, so it shows only under its parent. Detaching makes it top-level again, in its sector's section.
- A subtask made in Asana under a linked task arrives attached, in the parent unit's sector. A subtask made top-level in Asana can end up in no project at all; opsmap detaches its unit and puts the task back in its sector's section.
- A subtask that someone also added to the project (multi-homed) is read as a subtask: its section is ignored, and opsmap never removes it from the project.
- Completing a parent does not complete its subtasks, in Asana or in opsmap: the task force's unit is done, and its attached units keep their state.
- **Deleting a parent in Asana deletes its plain subtasks too**, a few seconds later. opsmap drops the task force's unit and the units whose tasks are gone. (For a moment the subtask is still there, top-level and in no project; a sync in that moment may put it back in its section, and the next sync drops its unit once Asana has deleted it.) A subtask that was also in the project survives as a top-level task in its section, and its unit stays linked and open.

## Requests and rate limits

Asana's project task list leaves out plain subtasks, so every sync reads them parent by parent. One sync makes these reads:

- the project's tasks that are open or were completed in the last 7 days (100 per request);
- the project's sections;
- the subtasks of each of those tasks that has subtasks, one request per parent, level by level, at most 5 levels down. Parents completed in the last 7 days are read too, so a subtask under a recently finished task force still syncs;
- one request for each linked unit whose task was not in those lists, such as a task moved out of the project. A done unit whose task was completed more than 7 days ago is the exception: such a unit is read again only about once a day, at most 10 of them in one sync and at most 50 in a `/tasks sync`, the one read longest ago first. A top-level task reopened in Asana is back in the project's list, so its unit reopens at the next sync; a reopened subtask whose parent was completed long ago is found at its daily read;
- the workspace's tags, only when a tag is written that the server does not know yet (the first one after a server start, or one new to the workspace), or when Asana no longer knows a tag the server kept (one deleted in Asana).

Writes cost one request for the fields, one per tag added or removed, and a re-read after a parent or section change. Asana is polled every 2 minutes, or every 10 minutes while webhooks deliver. That stays well under the free plan's 150 requests a minute for a project with a few dozen task forces, however many finished units the map keeps. A rate limit (HTTP 429) stops the sync, keeps the links made so far, shows `last error: rate limited, retrying in 30s` in `/tasks status`, and tries again after the time Asana gives (60 seconds if it gives none). The next sync starts at the unit where the last one stopped, so each try gets further, and it finishes without duplicates.

A refused token (HTTP 401) fails every sync of the map until its owner connects a working one. A refusal of one task (HTTP 403, for example a task the token may not change) fails only that unit: `/tasks sync` and `/tasks status` report it, and the other units sync.

## Webhooks

Webhooks only bring a sync forward; polling works without them.

- They need `PUBLIC_URL` to be a public HTTPS address, for example through a reverse proxy or a tunnel. On a private address (a LAN, a tailnet or a loopback development server) the server never asks Asana for one and polls every 2 minutes; `/tasks status` says why (`webhooks off: Asana needs a public HTTPS address; …`). `TASKSYNC_WEBHOOKS=on` makes the server try anyway; Asana cannot reach a private address, so the handshake fails and the map shows failed while it keeps polling.
- With a public address, binding registers one webhook on the project, posting to `PUBLIC_URL/api/tasksync/asana/hook/‹map›?h=‹nonce›`. The nonce is new for each webhook opsmap creates. Asana sends its handshake (`X-Hook-Secret`) while opsmap is still creating the webhook; the server answers it only on that URL, and only once. Any other handshake gets 401, so nobody else can register a webhook for the map.
- Each delivery must come to the webhook's URL and carry `X-Hook-Signature`, the HMAC-SHA256 of the body (hex) with the handshake's secret. Others get 401. Asana's heartbeats keep the map live without a sync.
- The webhook is checked every 10 minutes. One that Asana turned off (after failed deliveries) or that was deleted is made again, with a new nonce and secret. `/tasks sync` checks too, but does not remake a webhook that is still active.
- If the handshake fails, the map is failed (`webhooks failed: Asana could not complete the webhook handshake with PUBLIC_URL (HTTP 400: …)`), keeps polling, and tries again after 10 minutes, then less often.
- Asana's project webhooks may not report changes to plain subtasks, so those arrive with the next poll.
- Unbinding or deleting the map deletes its webhook.

## Testing against a real project

`npm run test:asana-live` runs `tests/live/asana-live.test.ts` against a real Asana project. It is skipped unless `ASANA_PAT_TOKEN` (a personal access token) and `ASANA_TEST_PROJECT` (a project gid) are set. Use a project made for testing. The test makes only tasks named `opsmap-live-…` and sections for its own two sectors, leaves every other task and section alone, and deletes what it made at the end, including tags it made that did not exist before.
