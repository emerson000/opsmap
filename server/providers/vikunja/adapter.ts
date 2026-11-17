// Vikunja behind the provider contract. The bound root is a project; each sector is one of its child projects; a
// task's state is its kanban bucket (To-Do, Doing, Blocked, Done), its identity an identity label, its parent the
// parenttask relation. Descriptions are HTML; opsmap notes are plain text. One session serves one sync cycle, so it
// keeps what it read (projects, boards, labels, the tasks as Vikunja sent them) for that cycle.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Affiliation } from '../../../src/core/model/types';
import { localDay } from '../../../src/core/model/time';
import { RateLimited, RemoteAuthError, type ProviderSession, type RelationKind, type RemoteContainer, type RemoteRoot, type RemoteStatus, type RemoteTask, type Snapshot, type TaskWrite, type WebhookResult } from '../../tasksync/contract';
import { dayInstant, NOTE_LIMIT } from '../../tasksync/merge';
import { IDENTITY_NAMES, affiliationOfName } from '../identity';
import { VkHttpError, type VkApi, type VkLabel, type VkProject, type VkRelationKind, type VkTask } from './api';

/** Identity ↔ Vikunja label: the first title is the one created; the others are also read. Colors follow the frames. */
const COLORS: Record<Affiliation, string> = { hostile: 'ff8080', suspect: 'ffbb66', friend: '80e0ff', assumed: 'b3ecff', neutral: 'aaffaa', unknown: 'ffff80', pending: 'fff3b0' };
export const AFFILIATION_LABELS: Record<Affiliation, { titles: string[]; color: string }> = Object.fromEntries((Object.keys(COLORS) as Affiliation[]).map(a => [a, { titles: IDENTITY_NAMES[a], color: COLORS[a] }])) as Record<Affiliation, { titles: string[]; color: string }>;
const affiliationOfTitle = affiliationOfName;
/** The identities a task's labels name (normally zero or one). */
const affiliationsOf = (t: VkTask): Affiliation[] => [...new Set((t.labels ?? []).map(l => affiliationOfTitle(l.title)).filter((a): a is Affiliation => a !== undefined))];

const codePoint = (n: number, raw: string) => { try { return String.fromCodePoint(n); } catch { return raw; } };
/** Vikunja descriptions are HTML; opsmap notes are plain text. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>\s*/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (m, n) => codePoint(Number(n), m)).replace(/&#x([0-9a-f]+);/gi, (m, n) => codePoint(parseInt(n, 16), m))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}
export function textToHtml(text: string): string {
  if (!text.trim()) return '';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return text.split('\n').map(line => `<p>${esc(line)}</p>`).join('');
}

const EVENTS = ['task.created', 'task.updated', 'task.deleted', 'task.relation.created', 'task.relation.deleted'];
/** Link orders ↔ relations, from the order's source: a plain link is related, a dependency is "blocked by", a handoff "precedes". */
const RELATION: Record<RelationKind, VkRelationKind> = { link: 'related', dependency: 'blocked', handoff: 'precedes' };
const ALIASES: Record<Exclude<RemoteStatus, 'done'>, string[]> = {
  todo: ['to-do', 'to do', 'todo', 'backlog'],
  active: ['doing', 'in progress', 'in-progress', 'active'],
  blocked: ['blocked', 'waiting', 'on hold'],
};
/** A sector project's kanban: which bucket means which state. */
interface Board { project: number; list: number; kanban: number | null; done: number; bucketOf: Partial<Record<RemoteStatus, number>>; statusOf: Map<number, RemoteStatus> }
type Hook = { project: number; id: number };
const noDate = (value: string | null | undefined) => !value || Date.parse(value) < Date.parse('1900-01-01');
/** The due date Vikunja should store: the unit's instant, the task's own when it is on the same day, or 17:00 that day. */
const dueDate = (w: TaskWrite, tz: string, current: string | null): string | null => {
  if (w.due === undefined && w.dueAt === undefined) return current;
  if (w.due === null || w.dueAt === null) return null;
  if (w.dueAt) return w.dueAt;
  return current && !noDate(current) && localDay(new Date(current), tz) === w.due ? current : dayInstant(w.due!, tz);
};

export class VikunjaSession implements ProviderSession {
  private projects?: VkProject[];
  private readonly boards = new Map<number, Board>();
  private labelIds?: Map<Affiliation, number>;
  /** Tasks as Vikunja last sent them this cycle, with their bucket. */
  private readonly raw = new Map<number, VkTask>();
  constructor(private readonly api: VkApi, readonly label = 'Vikunja') {}

  private async all(): Promise<VkProject[]> { return this.projects ??= await this.api.projects(); }
  private async createProject(title: string, parent: number): Promise<VkProject> { const made = await this.api.createProject(title, parent); (await this.all()).push(made); return made; }
  private async child(root: VkProject, title: string): Promise<VkProject> {
    const projects = await this.all(), lower = title.toLowerCase();
    return projects.find(p => p.parent_project_id === root.id && !p.is_archived && p.title.toLowerCase() === lower)
      ?? projects.find(p => p.parent_project_id === root.id && p.title.toLowerCase() === lower)
      ?? await this.createProject(title, root.id);
  }
  async resolveRoot(name: string): Promise<RemoteRoot> {
    // Live projects first: an archived one of the same name is history.
    const projects = [...await this.all()].sort((a, b) => Number(Boolean(a.is_archived)) - Number(Boolean(b.is_archived))), lower = name.toLowerCase();
    const root = projects.find(p => p.parent_project_id === 0 && p.title.toLowerCase() === lower) ?? projects.find(p => p.title.toLowerCase() === lower) ?? await this.createProject(name, 0);
    return { id: String(root.id), title: root.title };
  }
  async ensureContainers(root: RemoteRoot, names: { sectorId: string; name: string }[], known: Record<string, string>): Promise<Record<string, string>> {
    const projects = await this.all(), project = projects.find(p => p.id === Number(root.id));
    if (!project) throw new Error(`${this.label} project ${root.title} is gone: /tasks unbind`);
    const out: Record<string, string> = {};
    for (const { sectorId, name } of names) {
      const id = known[sectorId];
      out[sectorId] = id !== undefined && projects.some(p => p.id === Number(id)) ? id : String((await this.child(project, name)).id);
    }
    return out;
  }
  /** Vikunja keeps its child project's name: the sync has never renamed one. */
  async renameContainer(): Promise<void> { /* left to the user in Vikunja */ }

  /** The project's kanban, with a Blocked bucket added between Doing and Done when missing. */
  private async board(project: VkProject): Promise<Board> {
    const cached = this.boards.get(project.id); if (cached) return cached;
    const views = project.views ?? [];
    const list = views.find(v => v.view_kind === 'list'), kanban = views.find(v => v.view_kind === 'kanban' && v.bucket_configuration_mode === 'manual');
    if (!list) throw new Error(`${this.label} project ${project.title} has no list view`);
    const board: Board = { project: project.id, list: list.id, kanban: kanban?.id ?? null, done: kanban?.done_bucket_id ?? 0, bucketOf: {}, statusOf: new Map() };
    if (kanban) {
      const buckets = await this.api.buckets(project.id, kanban.id);
      const find = (status: Exclude<RemoteStatus, 'done'>) => buckets.find(b => b.id !== board.done && ALIASES[status].includes(b.title.trim().toLowerCase()));
      if (!find('blocked')) {
        const doing = find('active'), done = buckets.find(b => b.id === board.done);
        const position = doing?.position !== undefined && done?.position !== undefined && done.position > doing.position ? (doing.position + done.position) / 2 : undefined;
        buckets.push(await this.api.createBucket(project.id, kanban.id, 'Blocked', position));
      }
      for (const status of ['todo', 'active', 'blocked'] as const) { const b = find(status); if (b) { board.bucketOf[status] = b.id; board.statusOf.set(b.id, status); } }
      if (board.done) { board.bucketOf.done = board.done; board.statusOf.set(board.done, 'done'); }
    }
    this.boards.set(project.id, board);
    return board;
  }
  /** The board of a live project of this account, made on first use. */
  private async boardOf(projectId: number): Promise<Board | undefined> {
    const project = (await this.all()).find(p => p.id === projectId);
    return project && !project.is_archived ? this.board(project) : undefined;
  }
  private toRemote(t: VkTask, tz: string): RemoteTask {
    const board = this.boards.get(t.project_id), parents = (t.related_tasks?.parenttask ?? []).map(x => String(x.id));
    // From this task's side; Vikunja keeps the inverse (blocking, follows) on the other task.
    const related = (kind: VkRelationKind, as: RelationKind) => (t.related_tasks?.[kind] ?? []).map(x => ({ kind: as, to: String(x.id) }));
    return {
      id: String(t.id), title: t.title, note: htmlToText(t.description),
      due: noDate(t.due_date) ? null : localDay(new Date(t.due_date!), tz), dueAt: noDate(t.due_date) ? null : new Date(t.due_date!).toISOString(),
      status: t.done ? 'done' : t.bucket_id !== undefined && board ? board.statusOf.get(t.bucket_id) ?? null : null,
      progress: t.percent_done ?? 0, container: String(t.project_id), parent: parents[0] ?? null, parents, affiliations: affiliationsOf(t), updatedAt: t.updated,
      relations: [...related('related', 'link'), ...related('blocked', 'dependency'), ...related('precedes', 'handoff')],
    };
  }
  async snapshot(root: RemoteRoot, containers: Record<string, string>, tz: string): Promise<Snapshot> {
    const projects = await this.all(), tasks: RemoteTask[] = [], unmatched: Snapshot['unmatched'] = [], mine = new Set(Object.values(containers));
    // D12: a live child project that is no sector's is not synced; status lists it when it has open tasks. Only its
    // list view is read: no bucket is added to a project opsmap does not manage.
    for (const project of projects.filter(p => p.parent_project_id === Number(root.id) && !p.is_archived && !mine.has(String(p.id)))) {
      const list = (project.views ?? []).find(v => v.view_kind === 'list'); if (!list) continue;
      const open = (await this.api.tasks(project.id, list.id)).filter(t => !t.done).length;
      if (open) unmatched.push({ container: { id: String(project.id), name: project.title }, open });
    }
    for (const id of mine) {
      const project = projects.find(p => p.id === Number(id)); if (!project) continue;
      // An archived project is read-only in Vikunja: its sector waits until it is unarchived.
      if (project.is_archived) { const container: RemoteContainer = { id, name: project.title, archived: true }; unmatched.push({ container, open: 0 }); continue; }
      const board = await this.board(project);
      const bucketOf = board.kanban ? await this.api.bucketsOfTasks(board.project, board.kanban) : new Map<number, number>();
      for (const t of await this.api.tasks(board.project, board.list)) { const raw = { ...t, bucket_id: bucketOf.get(t.id) }; this.raw.set(t.id, raw); tasks.push(this.toRemote(raw, tz)); }
    }
    return { tasks, unmatched };
  }
  async getTask(_root: RemoteRoot, id: string, tz: string): Promise<RemoteTask | null> {
    const t = await this.api.task(Number(id)); if (!t) return null;
    // Its bucket, when its project's board was read this cycle (a task moved outside the A/O has none).
    const board = this.boards.get(t.project_id);
    if (board?.kanban && !t.done && t.bucket_id === undefined) t.bucket_id = (await this.api.bucketsOfTasks(board.project, board.kanban)).get(t.id);
    this.raw.set(t.id, t); return this.toRemote(t, tz);
  }
  /** Moves the card to the bucket for `status` (not done: marking done moves it). Returns the bucket it is in. */
  private async place(task: VkTask, status: RemoteStatus | null | undefined, current?: number): Promise<number | undefined> {
    const board = await this.boardOf(task.project_id);
    if (!board?.kanban || !status || status === 'done') return current;
    const bucket = board.bucketOf[status];
    if (bucket && bucket !== current) await this.api.moveToBucket(board.project, board.kanban, bucket, task.id);
    return bucket ?? current;
  }
  /** The identity label for `a`, made on first use. */
  private async labelId(a: Affiliation): Promise<number> {
    if (!this.labelIds) { this.labelIds = new Map(); for (const l of await this.api.labels()) { const x = affiliationOfTitle(l.title); if (x && !this.labelIds.has(x)) this.labelIds.set(x, l.id); } }
    const known = this.labelIds.get(a); if (known !== undefined) return known;
    const made = await this.api.createLabel(AFFILIATION_LABELS[a].titles[0], AFFILIATION_LABELS[a].color);
    this.labelIds.set(a, made.id); return made.id;
  }
  /** The task carries exactly one identity label, for `a` (none for null); the user's other labels are left alone. */
  private async setIdentity(task: VkTask, a: Affiliation | null): Promise<VkLabel[]> {
    const want = a === null ? undefined : await this.labelId(a);
    const labels = task.labels ?? [], current = labels.filter(l => affiliationOfTitle(l.title) !== undefined);
    let out = labels.filter(l => affiliationOfTitle(l.title) === undefined || l.id === want);
    if (want !== undefined && !current.some(l => l.id === want)) { await this.api.addLabel(task.id, want); out = [...out, { id: want, title: AFFILIATION_LABELS[a!].titles[0] }]; }
    for (const l of current) if (l.id !== want) await this.api.removeLabel(task.id, l.id);
    return out;
  }
  async createTask(_root: RemoteRoot, fields: TaskWrite & { title: string; container: string }, tz: string): Promise<RemoteTask> {
    const made = await this.api.createTask(Number(fields.container), {
      title: fields.title, description: textToHtml(fields.note ?? ''), due_date: dueDate(fields, tz, null), percent_done: fields.progress ?? 0, done: false,
    });
    let task: VkTask = { ...made, related_tasks: null };
    task.bucket_id = await this.place(task, fields.status, undefined);
    if (fields.affiliation !== undefined) task.labels = await this.setIdentity(task, fields.affiliation);
    if (fields.parent) { await this.api.addRelation(task.id, Number(fields.parent), 'parenttask'); task = { ...task, related_tasks: { parenttask: [{ id: Number(fields.parent) }] } }; }
    this.raw.set(task.id, task);
    return this.toRemote(task, tz);
  }
  async updateTask(_root: RemoteRoot, current: RemoteTask, changes: TaskWrite, tz: string): Promise<RemoteTask> {
    const id = Number(current.id), raw = this.raw.get(id) ?? await this.api.task(id);
    if (!raw) throw new Error(`${this.label} task ${id} is gone`);
    let task = raw;
    if ((['title', 'note', 'due', 'dueAt', 'status', 'progress', 'container'] as const).some(k => changes[k] !== undefined)) {
      // Vikunja replaces the whole task: start from its latest copy, so an edit made in Vikunja since the read (to
      // fields opsmap does not manage) is kept. A description longer than opsmap keeps stays as it is.
      const latest = await this.api.task(id) ?? raw, text = htmlToText(latest.description);
      const keep = changes.note === undefined || changes.note === text || text.length > NOTE_LIMIT && text.slice(0, NOTE_LIMIT).trim() === changes.note;
      const wanted: VkTask = {
        ...latest, bucket_id: raw.bucket_id, title: changes.title ?? latest.title, description: keep ? latest.description : textToHtml(changes.note!),
        due_date: dueDate(changes, tz, latest.due_date), percent_done: changes.progress ?? latest.percent_done,
        done: changes.status !== undefined ? changes.status === 'done' : latest.done, project_id: changes.container !== undefined ? Number(changes.container) : latest.project_id,
      };
      const updated = await this.api.updateTask(wanted);
      // A new project (sector moved) or a reopened task lands in that project's default bucket.
      const bucket = await this.place({ ...updated, project_id: wanted.project_id }, changes.status, wanted.project_id === raw.project_id && raw.done === wanted.done ? raw.bucket_id : undefined);
      task = { ...updated, project_id: wanted.project_id, bucket_id: bucket, labels: raw.labels, related_tasks: raw.related_tasks };
    }
    if (changes.affiliation !== undefined) task = { ...task, labels: await this.setIdentity({ ...task, labels: raw.labels }, changes.affiliation) };
    if (changes.parent !== undefined) {
      // A task force attachment is the parenttask relation; the parents opsmap was shown are replaced.
      const have = current.parents ?? (current.parent !== null ? [current.parent] : []), want = changes.parent;
      for (const p of have) if (p !== want) await this.api.removeRelation(id, Number(p), 'parenttask');
      if (want !== null && !have.includes(want)) await this.api.addRelation(id, Number(want), 'parenttask');
      const kept = (task.related_tasks?.parenttask ?? []).filter(x => !have.includes(String(x.id)));
      task = { ...task, related_tasks: { ...task.related_tasks, parenttask: [...kept, ...(want === null ? [] : [{ id: Number(want) }])] } };
    }
    this.raw.set(id, task);
    return this.toRemote(task, tz);
  }
  async deleteTask(_root: RemoteRoot, id: string): Promise<void> { await this.api.deleteTask(Number(id)); }
  async relate(_root: RemoteRoot, from: string, to: string, kind: RelationKind, add: boolean): Promise<void> {
    if (add) await this.api.addRelation(Number(from), Number(to), RELATION[kind]); else await this.api.removeRelation(Number(from), Number(to), RELATION[kind]);
  }
  /** One opsmap webhook per sector project, with opsmap's events. A webhook deleted or altered in Vikunja is made again;
   *  one on a project no longer watched is removed. The state is the list of webhooks opsmap made. */
  async ensureWebhooks(_root: RemoteRoot, containers: string[], target: string, secret: string, state: unknown): Promise<Hook[]> {
    const hooks = Array.isArray(state) ? state as Hook[] : [], projects = containers.map(Number);
    const kept = hooks.filter(h => projects.includes(h.project));
    for (const h of hooks) if (!projects.includes(h.project)) await this.api.deleteWebhook(h.project, h.id).catch(() => undefined);
    const sameEvents = (events: string[]) => [...events].sort().join() === [...EVENTS].sort().join();
    for (const project of projects) {
      const existing = (await this.api.webhooks(project)).find(w => w.target_url === target);
      if (existing && sameEvents(existing.events) && kept.some(h => h.project === project && h.id === existing.id)) continue;
      if (existing) await this.api.deleteWebhook(project, existing.id).catch(() => undefined);
      const made = await this.api.createWebhook(project, target, EVENTS, secret);
      const i = kept.findIndex(h => h.project === project); if (i >= 0) kept.splice(i, 1);
      kept.push({ project, id: made.id });
    }
    return kept;
  }
  async removeWebhooks(_root: RemoteRoot, state: unknown): Promise<void> {
    for (const h of Array.isArray(state) ? state as Hook[] : []) await this.api.deleteWebhook(h.project, h.id).catch(() => undefined);
  }
}

/** Vikunja's refusals as the contract's: 401 is a refused token, 429 a rate limit. */
const translate = (error: unknown): unknown => error instanceof VkHttpError ? error.status === 401 ? new RemoteAuthError(error.message) : error.status === 429 ? new RateLimited(error.retryAfterS ?? 60) : error : error;
export function vikunjaSession(api: VkApi, label?: string): ProviderSession {
  const session = new VikunjaSession(api, label);
  return new Proxy(session, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    return typeof value === 'function' ? async (...args: unknown[]) => { try { return await value.apply(target, args); } catch (error) { throw translate(error); } } : value;
  } });
}
/** Vikunja signs each delivery with HMAC-SHA256 of the body in X-Vikunja-Signature. */
export function receiveVikunjaWebhook(headers: Headers, body: string, secret: string): WebhookResult {
  const signature = headers.get('x-vikunja-signature');
  if (!signature) return { status: 401, trigger: false };
  const want = Buffer.from(createHmac('sha256', secret).update(body).digest('hex')), got = Buffer.from(signature.trim().toLowerCase());
  return want.length === got.length && timingSafeEqual(want, got) ? { status: 200, trigger: true } : { status: 401, trigger: false };
}
