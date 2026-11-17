// Asana behind the provider contract (D11). The bound root is a project; each sector is one of its sections; a task's
// state is completed plus the tags `doing` and `blocked`; its identity an identity tag (both made in the project's
// workspace on first use, reused by name); its parent Asana's parent task. Due dates are days (`due_on`): a `due_at`
// is read as its day in the map's zone, and a write sets the day and clears the time. One session serves one sync
// cycle, so it keeps what it read (the project's workspace and sections, the workspace's tags, the tasks) for that cycle.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Affiliation } from '../../../src/core/model/types';
import { localDay } from '../../../src/core/model/time';
import { RateLimited, RemoteAuthError, type ProviderSession, type RemoteRoot, type RemoteStatus, type RemoteTask, type Snapshot, type TaskWrite, type WebhookResult } from '../../tasksync/contract';
import { NOTE_LIMIT } from '../../tasksync/merge';
import { IDENTITY_NAMES, affiliationOfName } from '../identity';
import { AsHttpError, type AsApi, type AsNewTask, type AsProject, type AsRef, type AsSection, type AsTag, type AsTask, type AsTaskFields } from './api';

/** Identity tags, in Asana's tag colors closest to the frame colors (Asana accepts only its own color names). */
export const IDENTITY_COLORS: Record<Affiliation, string> = { hostile: 'light-red', suspect: 'light-orange', friend: 'light-blue', assumed: 'light-teal', neutral: 'light-green', unknown: 'light-yellow', pending: 'light-warm-gray' };
/** The state tags: neither means to do; completed means done whatever the tags say. */
export const STATE_TAGS = { active: 'doing', blocked: 'blocked' } as const;
const STATE_COLORS: Record<string, string> = { doing: 'dark-blue', blocked: 'dark-red' };
/** Done tasks are read for this long, so a task finished in Asana still finishes its unit. */
const RECENT_MS = 7 * 86_400_000;
/** Subtasks are read this many levels down. */
const DEPTH = 5;

const lower = (s: string | undefined) => (s ?? '').trim().toLowerCase();
const stateOfTag = (name: string | undefined) => (Object.keys(STATE_TAGS) as (keyof typeof STATE_TAGS)[]).find(k => STATE_TAGS[k] === lower(name));
/** A project gid from a gid or an Asana project URL (`/0/‹project›/…` or `/1/‹workspace›/project/‹project›/…`); `url`: the text was a URL. */
export function projectRef(text: string): { gid?: string; url: boolean } {
  const t = text.trim();
  if (/^\d{1,30}$/.test(t)) return { gid: t, url: false };
  if (!/^https?:\/\//i.test(t)) return { url: false };
  let u: URL; try { u = new URL(t); } catch { return { url: true }; }
  if (!/(^|\.)asana\.com$/i.test(u.hostname)) return { url: true };
  const parts = u.pathname.split('/').filter(Boolean), at = parts.indexOf('project'), gid = /^\d{1,30}$/;
  if (at >= 0 && gid.test(parts[at + 1] ?? '')) return { gid: parts[at + 1], url: true };
  if (parts[0] === '0' && gid.test(parts[1] ?? '')) return { gid: parts[1], url: true };
  return { url: true };
}
/** The task's due day in `tz`: the day of `due_at` when it has a time, else `due_on`. */
const dueOf = (t: AsTask, tz: string) => t.due_at ? localDay(new Date(t.due_at), tz) : t.due_on ?? null;
const sectionIn = (t: AsTask, project: string) => t.memberships.find(m => m.project?.gid === project)?.section?.gid ?? null;

/** Webhook creations in flight, by the map's secret (the engine's, passed to ensureWebhooks and receiveWebhook). Asana
 *  sends its handshake while `POST /webhooks` is still open; it is answered only then, and only once per creation. */
export type Handshakes = Map<string, { answered: boolean }>;
/** The webhook ensureWebhooks keeps (ts_maps.hooks): one per bound project. */
const hookGid = (state: unknown) => state && typeof state === 'object' && typeof (state as { gid?: unknown }).gid === 'string' ? (state as { gid: string }).gid : undefined;
/** The secret Asana's handshake gave (ts_maps.state, stored through WebhookResult.store). */
const hookSecret = (state: unknown) => state && typeof state === 'object' && typeof (state as { secret?: unknown }).secret === 'string' ? (state as { secret: string }).secret : undefined;
export const asanaHookCount = (state: unknown) => hookGid(state) ? 1 : 0;
/** A handshake (`X-Hook-Secret`), echoed and stored only while a creation for this map is open; or a delivery, signed with
 *  that secret (`X-Hook-Signature`: hex HMAC-SHA256 of the body as received). A heartbeat (`events: []`) starts no cycle. */
export function receiveAsanaWebhook(headers: Headers, body: string, mapSecret: string, state: unknown, handshakes: Handshakes): WebhookResult {
  const refused: WebhookResult = { status: 401, trigger: false }, offered = headers.get('x-hook-secret');
  if (offered !== null) {
    const waiting = handshakes.get(mapSecret);
    if (!waiting || waiting.answered || !/^[\x21-\x7e]{1,256}$/.test(offered)) return refused;
    waiting.answered = true;
    return { status: 200, headers: { 'X-Hook-Secret': offered }, store: { secret: offered }, trigger: false };
  }
  const secret = hookSecret(state), signature = headers.get('x-hook-signature');
  if (!secret || !signature) return refused;
  const want = Buffer.from(createHmac('sha256', secret).update(body).digest('hex')), got = Buffer.from(signature.trim().toLowerCase());
  if (want.length !== got.length || !timingSafeEqual(want, got)) return refused;
  let events: unknown; try { events = (JSON.parse(body) as { events?: unknown }).events; } catch { /* signed but not JSON: sync anyway */ }
  return Array.isArray(events) && events.length === 0 ? { status: 200, trigger: false, live: true } : { status: 200, trigger: true };
}

export class AsanaSession implements ProviderSession {
  private readonly workspaces = new Map<string, string>();   // project gid → workspace gid
  private readonly sections = new Map<string, AsSection[]>();
  private tagIndex?: Map<string, AsTag>;
  /** Tasks as Asana last sent them this cycle. */
  private readonly raw = new Map<string, AsTask>();
  constructor(private readonly api: AsApi, readonly label = 'Asana', private readonly handshakes: Handshakes = new Map()) {}

  private remember(p: AsProject, workspace?: string): RemoteRoot { const ws = p.workspace?.gid ?? workspace; if (ws) this.workspaces.set(p.gid, ws); return { id: p.gid, title: p.name }; }
  /** The project, or undefined when this token cannot see it. */
  private async project(gid: string): Promise<AsProject | undefined> {
    try { return await this.api.project(gid); } catch (error) { if (error instanceof AsHttpError && (error.status === 404 || error.status === 403)) return undefined; throw error; }
  }
  async resolveRoot(nameOrUrl: string): Promise<RemoteRoot> {
    const text = nameOrUrl.replace(/\s+/g, ' ').trim(), ref = projectRef(text);
    if (ref.gid) { const p = await this.project(ref.gid); if (p) return this.remember(p); }
    if (ref.url) throw new Error(ref.gid ? `No ${this.label} project ${ref.gid} that this token can see` : `Not a ${this.label} project URL: ${text.slice(0, 120)}`);
    // By name, in every workspace the token sees: a live project wins over archived ones.
    const workspaces = (await this.api.me()).workspaces, found: { p: AsProject; ws: string }[] = [];
    for (const ws of workspaces) for (const p of await this.api.projects(ws.gid)) if (lower(p.name) === lower(text)) found.push({ p, ws: ws.gid });
    const live = found.filter(x => !x.p.archived), pick = live.length ? live : found;
    if (pick.length > 1) throw new Error(`Several ${this.label} projects named ${text}: ${pick.map(x => x.p.gid).join(', ')}`);
    if (pick.length === 1) return this.remember(pick[0].p, pick[0].ws);
    if (workspaces.length !== 1) throw new Error(workspaces.length ? `Several ${this.label} workspaces: bind by project URL` : `This ${this.label} account has no workspace`);
    return this.remember(await this.api.createProject(workspaces[0].gid, text), workspaces[0].gid);
  }
  private async workspace(root: RemoteRoot): Promise<string> {
    const known = this.workspaces.get(root.id); if (known) return known;
    const p = await this.project(root.id); if (!p) throw new Error(`${this.label} project ${root.title} is gone: /tasks unbind`);
    this.remember(p); const ws = this.workspaces.get(root.id); if (!ws) throw new Error(`${this.label} project ${root.title} has no workspace`);
    return ws;
  }
  private async sectionsOf(root: RemoteRoot): Promise<AsSection[]> {
    const cached = this.sections.get(root.id); if (cached) return cached;
    let list: AsSection[];
    try { list = await this.api.sections(root.id); } catch (error) { if (error instanceof AsHttpError && error.status === 404) throw new Error(`${this.label} project ${root.title} is gone: /tasks unbind`); throw error; }
    this.sections.set(root.id, list); return list;
  }
  async ensureContainers(root: RemoteRoot, names: { sectorId: string; name: string }[], known: Record<string, string>): Promise<Record<string, string>> {
    const sections = await this.sectionsOf(root), out: Record<string, string> = {};
    for (const { sectorId, name } of names) {
      const id = known[sectorId];
      if (id !== undefined && sections.some(s => s.gid === id)) { out[sectorId] = id; continue; }
      const found = sections.find(s => lower(s.name) === lower(name)) ?? await this.api.createSection(root.id, name);
      if (!sections.includes(found)) sections.push(found);
      out[sectorId] = found.gid;
    }
    return out;
  }
  async renameContainer(root: RemoteRoot, id: string, name: string): Promise<void> {
    await this.api.renameSection(id, name);
    const s = this.sections.get(root.id)?.find(x => x.gid === id); if (s) s.name = name;
  }

  private toRemote(t: AsTask, root: RemoteRoot, tz: string): RemoteTask {
    const states = new Set(t.tags.map(x => stateOfTag(x.name)).filter(s => s !== undefined));
    // Both tags: a state opsmap cannot read; the next push settles it.
    const status: RemoteStatus | null = t.completed ? 'done' : states.size > 1 ? null : states.has('blocked') ? 'blocked' : states.has('active') ? 'active' : 'todo';
    const parent = t.parent?.gid ?? null;
    return {
      id: t.gid, title: t.name, note: t.notes ?? '', due: dueOf(t, tz), dueAt: t.due_at ? new Date(t.due_at).toISOString() : null, status, progress: null,
      // A subtask is read as a subtask, even when it is also in a section (multi-homed): it has no container.
      container: parent === null ? sectionIn(t, root.id) : null, parent,
      affiliations: [...new Set(t.tags.map(x => affiliationOfName(x.name ?? '')).filter((a): a is Affiliation => a !== undefined))], updatedAt: t.modified_at,
    };
  }
  async snapshot(root: RemoteRoot, containers: Record<string, string>, tz: string): Promise<Snapshot> {
    const since = new Date(Date.now() - RECENT_MS).toISOString(), top = await this.api.tasks(root.id, since), seen = new Map<string, AsTask>();
    for (const t of top) seen.set(t.gid, t);
    // The project's list leaves out plain subtasks: read them under each parent, a level at a time, at most DEPTH levels
    // below a top-level task. Only tasks in the list are read (open, or done in the last 7 days: the contract does not
    // say which tasks have linked children); a linked child under an older parent is read by the engine with getTask.
    // A multi-homed subtask is also in the list, but it is read under its parent, so the depth counts from the top; one
    // whose parent is not in the list (done long ago, or in another project) is read from the list.
    const expanded = new Set<string>();
    let level = top.filter(t => t.num_subtasks > 0 && (t.parent === null || !seen.has(t.parent.gid)));
    for (let depth = 0; depth < DEPTH && level.length; depth++) {
      const next: AsTask[] = [];
      for (const p of level) {
        if (expanded.has(p.gid)) continue; expanded.add(p.gid);
        for (const c of await this.api.subtasks(p.gid, since)) { if (!seen.has(c.gid)) seen.set(c.gid, c); if (c.num_subtasks > 0 && !expanded.has(c.gid)) next.push(c); }
      }
      level = next;
    }
    for (const t of seen.values()) this.raw.set(t.gid, t);
    // D12: a section that is no sector's is not synced; status lists it when it has open tasks.
    const mine = new Set(Object.values(containers)), unmatched: Snapshot['unmatched'] = [];
    for (const s of await this.sectionsOf(root)) {
      if (mine.has(s.gid)) continue;
      const open = top.filter(t => !t.completed && !t.parent && sectionIn(t, root.id) === s.gid).length;
      if (open) unmatched.push({ container: { id: s.gid, name: s.name }, open });
    }
    return { tasks: [...seen.values()].map(t => this.toRemote(t, root, tz)), unmatched };
  }
  async getTask(root: RemoteRoot, id: string, tz: string): Promise<RemoteTask | null> {
    const t = await this.api.task(id); if (!t) return null;
    this.raw.set(id, t); return this.toRemote(t, root, tz);
  }

  /** The workspace's tag named `name` (any case), made on first use. */
  private async tag(root: RemoteRoot, names: string[], color: string): Promise<AsRef> {
    const ws = await this.workspace(root);
    if (!this.tagIndex) { this.tagIndex = new Map(); for (const t of await this.api.tags(ws)) if (!this.tagIndex.has(lower(t.name))) this.tagIndex.set(lower(t.name), t); }
    for (const n of names) { const found = this.tagIndex.get(lower(n)); if (found) return found; }
    const made = await this.api.createTag(ws, names[0], color);
    this.tagIndex.set(lower(made.name), made); return made;
  }
  /** Adds and removes tags on the task; the result is the task with its new tags. */
  private async retag(t: AsTask, add: AsRef[], remove: AsRef[]): Promise<AsTask> {
    for (const r of remove) await this.api.removeTag(t.gid, r.gid);
    for (const a of add) await this.api.addTag(t.gid, a.gid);
    const gone = new Set(remove.map(r => r.gid));
    return { ...t, tags: [...t.tags.filter(x => !gone.has(x.gid)), ...add.filter(a => !t.tags.some(x => x.gid === a.gid)).map(a => ({ gid: a.gid, name: a.name }))] };
  }
  /** The state tags for `status`: `doing` or `blocked`, the other one removed; none for todo. Done leaves them. */
  private async setState(root: RemoteRoot, t: AsTask, status: RemoteStatus | null | undefined): Promise<AsTask> {
    if (!status || status === 'done') return t;
    const want = status === 'active' ? STATE_TAGS.active : status === 'blocked' ? STATE_TAGS.blocked : undefined;
    const current = t.tags.filter(x => stateOfTag(x.name) !== undefined), keep = current.filter(x => lower(x.name) === want);
    const add = want && !keep.length ? [await this.tag(root, [want], STATE_COLORS[want])] : [];
    return this.retag(t, add, current.filter(x => lower(x.name) !== want));
  }
  /** Exactly one identity tag, for `a`; null removes the identity tags. The user's other tags are left alone. */
  private async setIdentity(root: RemoteRoot, t: AsTask, a: Affiliation | null): Promise<AsTask> {
    const current = t.tags.filter(x => affiliationOfName(x.name ?? '') !== undefined), keep = a === null ? [] : current.filter(x => affiliationOfName(x.name ?? '') === a);
    const add = a !== null && !keep.length ? [await this.tag(root, IDENTITY_NAMES[a], IDENTITY_COLORS[a])] : [];
    return this.retag(t, add, current.filter(x => !keep.includes(x)));
  }
  /** Makes the task a subtask of `parent`, or top-level again in the project, in `section` (D13). A top-level task that
   *  opsmap makes a subtask leaves the project; a subtask the user also keeps in the project (multi-homed) stays there. */
  private async setParent(root: RemoteRoot, t: AsTask, parent: string | null, section: string | undefined): Promise<void> {
    await this.api.setParent(t.gid, parent);
    const inRoot = t.memberships.some(m => m.project?.gid === root.id);
    if (parent !== null) { if (t.parent === null && inRoot) await this.api.removeProject(t.gid, root.id); }
    else if (section !== undefined || !inRoot) await this.api.addProject(t.gid, root.id, section);
  }
  /** Into the section; a task in no project (made top-level in Asana) is put back in the project there. */
  private async moveTo(root: RemoteRoot, t: AsTask, section: string): Promise<void> {
    if (t.memberships.some(m => m.project?.gid === root.id)) await this.api.addToSection(section, t.gid); else await this.api.addProject(t.gid, root.id, section);
  }
  async createTask(root: RemoteRoot, fields: TaskWrite & { title: string; container: string }, tz: string): Promise<RemoteTask> {
    const body: AsNewTask = { name: fields.title, ...(fields.note ? { notes: fields.note } : {}), ...(fields.due ? { due_on: fields.due } : {}), ...(fields.status === 'done' ? { completed: true } : {}) };
    // Put in its section explicitly: a task made with only a project may land in no section. Asana refuses
    // memberships without projects (400 "You should specify one of workspace, parent, projects").
    let t = await this.api.createTask(fields.parent ? { ...body, parent: fields.parent } : { ...body, projects: [root.id], memberships: [{ project: root.id, section: fields.container }] });
    t = await this.setState(root, t, fields.status);
    if (fields.affiliation !== undefined) t = await this.setIdentity(root, t, fields.affiliation);
    this.raw.set(t.gid, t);
    return this.toRemote(t, root, tz);
  }
  async updateTask(root: RemoteRoot, current: RemoteTask, changes: TaskWrite, tz: string): Promise<RemoteTask> {
    let t = this.raw.get(current.id) ?? await this.api.task(current.id);
    if (!t) throw new Error(`${this.label} task ${current.id} is gone`);
    const f: AsTaskFields = {};
    if (changes.title !== undefined && changes.title !== t.name) f.name = changes.title;
    if (changes.note !== undefined) {
      // A note longer than opsmap keeps stays as it is in Asana while its start matches.
      const notes = t.notes ?? '', keep = changes.note === notes.trim() || notes.length > NOTE_LIMIT && notes.slice(0, NOTE_LIMIT).trim() === changes.note;
      if (!keep) f.notes = changes.note;
    }
    if (changes.due !== undefined && changes.due !== dueOf(t, tz)) { f.due_on = changes.due; if (t.due_at) f.due_at = null; }
    if (changes.status !== undefined && changes.status !== null && (changes.status === 'done') !== t.completed) f.completed = changes.status === 'done';
    if (Object.keys(f).length) t = await this.api.updateTask(t.gid, f);
    t = await this.setState(root, t, changes.status);
    if (changes.affiliation !== undefined) t = await this.setIdentity(root, t, changes.affiliation);
    // Parent and section writes return nothing: the task is read again, so its modified_at is Asana's (the engine's
    // newer-wins check compares it).
    if (changes.parent !== undefined && changes.parent !== (t.parent?.gid ?? null)) { await this.setParent(root, t, changes.parent, changes.container ?? undefined); t = await this.api.task(t.gid) ?? t; }
    // A subtask stays under its parent: its section is not opsmap's.
    if (changes.container && t.parent === null && sectionIn(t, root.id) !== changes.container) { await this.moveTo(root, t, changes.container); t = await this.api.task(t.gid) ?? t; }
    this.raw.set(t.gid, t);
    return this.toRemote(t, root, tz);
  }
  async deleteTask(_root: RemoteRoot, id: string): Promise<void> { await this.api.deleteTask(id); }

  /** One webhook on the project, posting to `target`. One Asana deactivated (after failed deliveries) or a second one is
   *  deleted; a missing one is made. A refusal other than a rate limit or a refused token is a webhook failure (the
   *  engine keeps polling and retries), never a sync error. */
  async ensureWebhooks(root: RemoteRoot, _containers: string[], target: string, secret: string): Promise<unknown> {
    try {
      const mine = (await this.api.webhooks(await this.workspace(root), root.id)).filter(h => h.target === target), live = mine.find(h => h.active !== false);
      for (const h of mine) if (h !== live) await this.forget(h.gid);
      return { gid: live?.gid ?? (await this.create(root.id, target, secret)).gid };
    } catch (error) {
      if (error instanceof AsHttpError && error.status !== 429 && error.status !== 401) throw new Error(error.message);
      throw error;
    }
  }
  async removeWebhooks(_root: RemoteRoot, state: unknown): Promise<void> { const gid = hookGid(state); if (gid) await this.forget(gid); }
  /** Asana answers `POST /webhooks` only after the handshake, so the handshake is expected for exactly this long. */
  private async create(project: string, target: string, secret: string) {
    const waiting = { answered: false }; this.handshakes.set(secret, waiting);
    try { return await this.api.createWebhook(project, target); }
    catch (error) {
      // What Asana answers when the target did not echo the handshake (it waits a while first).
      if (error instanceof AsHttpError && (error.status === 400 || error.status === 403)) throw new Error(`${this.label} could not complete the webhook handshake with PUBLIC_URL (HTTP ${error.status})`);
      throw error;
    } finally { if (this.handshakes.get(secret) === waiting) this.handshakes.delete(secret); }
  }
  private async forget(gid: string): Promise<void> {
    try { await this.api.deleteWebhook(gid); } catch (error) { if (!(error instanceof AsHttpError && error.status === 404)) throw error; }
  }
}

/** Asana's refusals as the contract's: 429 is a rate limit (Retry-After, else 60 s); 401 and 403 a refused token. */
export const translate = (error: unknown): unknown => error instanceof AsHttpError ? error.status === 429 ? new RateLimited(error.retryAfterS ?? 60) : error.status === 401 || error.status === 403 ? new RemoteAuthError(error.message) : error : error;
export function asanaSession(api: AsApi, label?: string, handshakes?: Handshakes): ProviderSession {
  const session = new AsanaSession(api, label, handshakes);
  return new Proxy(session, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    return typeof value === 'function' ? async (...args: unknown[]) => { try { return await value.apply(target, args); } catch (error) { throw translate(error); } } : value;
  } });
}
