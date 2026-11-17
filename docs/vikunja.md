# Vikunja sync

Optional two-way sync with [Vikunja](https://vikunja.io). Set `VIKUNJA_URL` (the Vikunja origin) to turn it on; without it the `vikunja` service and its alias `/vk` are hidden. The server only ever talks to that origin. Binding, merging, field switches, delivery modes and the `/tasks` commands work as [Task sync](task-sync.md) describes; this page covers what is specific to Vikunja.

## Setup

- Each user connects their own Vikunja account: user menu (phone: menu) → **Vikunja…**, then paste an API token made in Vikunja under Settings → API Tokens (projects, tasks, buckets and webhooks). The server checks it with Vikunja (`GET /user`) before saving it, and the panel shows only the Vikunja user name.
- `/tasks bind "Project"` (or `/vk bind "Project"`; `/tasks bind vikunja "Project"` when the server has more than one task service) binds the open map to a Vikunja project, found by title or created. Each sector becomes a child project with the sector's name. `/vk status`, `/vk sync`, `/vk unbind` and `/vk field …` work the same as the `/tasks` forms.

## What syncs

- Title; due date (compared by calendar day in the map's zone); note ↔ description (plain text; HTML from Vikunja is stripped); BDA ↔ progress for hostiles and suspects (60% done = 40% strength; a friendly's strength is capacity, so it is not synced); sector ↔ child project (moving a task to another sector project moves the unit).
- State ↔ kanban bucket: To-Do = todo, Doing = active, Blocked = blocked (bind adds the bucket), Done = done. Tasks in buckets of your own keep their unit's state. With `state` off, only done syncs: a done task moves to Done, a reopened one goes where Vikunja puts it, and opsmap moves no card between the other buckets.
- A task moved to a project outside the A/O, or left in a removed or archived sector's project, goes back to its unit's sector. Child projects of the bound project that are no sector's are listed by `/tasks status` (`not synced: project Home (2 tasks)`).
- Identity ↔ labels: each task carries one identity label, `hostile`, `suspect`, `friendly`, `assumed`, `neutral`, `unknown` or `pending` (`enemy` and `friend` are read too). Labels are matched by title ignoring case and created, colored like the frames, on first use; other labels are left alone. Setting one in Vikunja runs `/id`; `/id` swaps the label. A task with no identity label gets its unit's; one with several keeps opsmap's identity and loses the extras. A task made in Vikunja with an identity label arrives with that identity instead of pending.

## Relations

Relations sync between units that both have a task.

- A unit attached to a task force is a subtask of the task force's task (its parent task). A subtask stays in its sector's project. A subtask added in Vikunja (from either task) runs `/attach`; removing it runs `/detach`. A unit has one task force, so a task with several parent tasks keeps its unit's task force until you remove the extra ones. Parent tasks outside the A/O are left alone.
- `/link A B` is "related", `/link A B as dependency` is "A is blocked by B" (B is blocking A), and `/link A B as handoff` is "A precedes B" (B follows A). A relation of one of these kinds added in Vikunja runs `/link`; removing it there cancels the link order. Cancelling the order in opsmap (`/halt`) removes the relation. A relation opsmap cannot take, such as one between units in different sectors where neither is a task force, is reported once by `/vk sync` and left in Vikunja.
- Links sync only while both units are open: `/done` and `/drop` end a unit's link orders, but its task keeps its relations. Other kinds (duplicate of, copied from) and relations to tasks outside the A/O are not synced.

## Webhooks

- opsmap manages one webhook per sector project (`task.created`, `task.updated`, `task.deleted`, `task.relation.created`, `task.relation.deleted`). They post to `PUBLIC_URL/api/vikunja/hook/‹map›`, the path older servers registered, so webhooks made before the upgrade keep working. The server also accepts the generic `PUBLIC_URL/api/tasksync/vikunja/hook/‹map›`.
- Deliveries are signed with the map's secret (HMAC-SHA256 in `X-Vikunja-Signature`); unsigned or wrongly signed deliveries get 401.
- Bind registers them. They are checked every 10 minutes and at once on `/vk sync` or a sector change, and a webhook deleted or altered in Vikunja is made again. Unbinding or deleting the map removes them. `/vk status` shows how many are registered and the last delivery (`5 webhooks · last delivery 18:22:59Z`).
- Vikunja polls every minute, or every 5 minutes while webhooks deliver.
- Webhooks need `PUBLIC_URL` to be an address Vikunja can reach (not loopback). Vikunja refuses private addresses, tailnet ones included, unless it runs with `VIKUNJA_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS=true`. While webhooks are registered but nothing arrives, `/vk status` gives that hint: `5 webhooks, none delivered yet: if changes in Vikunja take a minute to arrive, set VIKUNJA_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS=true on Vikunja (it refuses private addresses) · polling every minute`.
- For a Vikunja on the same machine or LAN, `TASKSYNC_WEBHOOKS=on` registers webhooks even when `PUBLIC_URL` looks private. With the default (`auto`), a loopback `PUBLIC_URL` gives `polling every minute (webhooks need PUBLIC_URL to be an address Vikunja can reach)`.
- Vikunja's webhook URLs carry no per-webhook proof, so during a flood of forged requests to the hook path its real deliveries are answered 429 too, and changes arrive by polling until the flood stops ([The webhook endpoint](task-sync.md#the-webhook-endpoint)).

`/reopen <unit>` (any map) returns a done or dropped unit to To do.
