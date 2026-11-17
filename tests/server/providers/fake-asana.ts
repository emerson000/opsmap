// An in-memory Asana with the behavior the sync relies on (spike against the real API, 2026-11-17):
// project task lists omit plain subtasks, and a plain subtask has no memberships (until `addProject` multi-homes it);
// `setParent` keeps memberships, `setParent(null)` leaves none until `addProject`; completing a parent leaves its children open;
// a deleted task reads 404 (`task()` gives null); a tag needs a workspace; `completed_since` keeps open tasks and those completed at or after it.
// Not probed, so not modeled: deleting a parent does not delete its children here.
// `tick()` advances the clock that stamps `modified_at`. `failNext` and `rateLimit` make the next call to a method fail.
import { AsHttpError } from '../../../server/providers/asana/api';
import type { AsApi, AsMembership, AsNewTask, AsProject, AsSection, AsTag, AsTask, AsTaskFields, AsUser, AsWebhook } from '../../../server/providers/asana/api';

interface Rec { gid: string; name: string; notes: string; completed: boolean; completedAt: number | null; due_on: string | null; due_at: string | null; modified: number; parent: string | null; memberships: { project: string; section?: string }[]; tags: string[] }
/** The tag colors Asana accepts (live probe, 2026-11-17). */
export const TAG_COLORS = ['dark-blue', 'dark-brown', 'dark-green', 'dark-orange', 'dark-pink', 'dark-purple', 'dark-red', 'dark-teal', 'dark-warm-gray', 'light-blue', 'light-green', 'light-orange', 'light-pink', 'light-purple', 'light-red', 'light-teal', 'light-warm-gray', 'light-yellow', 'none'];
const notFound = (method: string, path: string, what = 'Not a recognized ID') => new AsHttpError(404, `Asana ${method} ${path}: ${what}`);

export class FakeAsana implements AsApi {
  workspaces = new Map<string, string>();       // gid → name
  projectsById = new Map<string, AsProject & { workspaceGid: string }>();
  sectionsById = new Map<string, AsSection & { project: string }>();
  tasksById = new Map<string, Rec>();
  tagsById = new Map<string, AsTag & { workspace: string; color?: string }>();
  hooks = new Map<string, AsWebhook & { workspace: string }>();
  calls: string[] = [];
  private nextId = 5000;
  private clock = Date.now();
  private failures: { method: string; error: Error }[] = [];
  private id() { return String(this.nextId++); }
  tick(ms = 1000) { this.clock += ms; return new Date(this.clock).toISOString(); }
  now() { return new Date(this.clock).toISOString(); }
  /** The next call to `method` (or any method with '*') throws `error`. */
  failNext(method: string, error: Error) { this.failures.push({ method, error }); }
  /** The next call to `method` throws a 429 with `Retry-After` seconds. */
  rateLimit(method: string, retryAfterS = 30) { this.failNext(method, new AsHttpError(429, `Asana ${method}: Rate limit exceeded`, retryAfterS)); }
  private enter(method: string, ...args: unknown[]) {
    this.calls.push([method, ...args.filter(a => typeof a === 'string')].join(' '));
    const i = this.failures.findIndex(f => f.method === method || f.method === '*');
    if (i >= 0) throw this.failures.splice(i, 1)[0].error;
  }

  /** As the account would have it: register a workspace the token can see. */
  workspace(gid: string, name = `Workspace ${gid}`) { this.workspaces.set(gid, name); return gid; }
  async me(): Promise<AsUser> { this.enter('me'); return { gid: '1', name: 'Alice', workspaces: [...this.workspaces].map(([gid, name]) => ({ gid, name })) }; }
  async projects(workspace: string) { this.enter('projects', workspace); return [...this.projectsById.values()].filter(p => p.workspaceGid === workspace).map(({ workspaceGid: _w, ...p }) => structuredClone(p)); }
  async project(gid: string) { this.enter('project', gid); const p = this.projectsById.get(gid); if (!p) throw notFound('GET', `/projects/${gid}`); const { workspaceGid: _w, ...rest } = p; return structuredClone(rest); }
  async createProject(workspace: string, name: string) {
    this.enter('createProject', workspace, name);
    const p = { gid: this.id(), name, archived: false, workspace: { gid: workspace, name: this.workspaces.get(workspace) }, workspaceGid: workspace }; this.projectsById.set(p.gid, p);
    const { workspaceGid: _w, ...rest } = p; return structuredClone(rest);
  }
  async sections(project: string) { this.enter('sections', project); return [...this.sectionsById.values()].filter(s => s.project === project).map(s => ({ gid: s.gid, name: s.name })); }
  async createSection(project: string, name: string) { this.enter('createSection', project, name); const s = { gid: this.id(), name, project }; this.sectionsById.set(s.gid, s); return { gid: s.gid, name }; }
  async renameSection(gid: string, name: string) { this.enter('renameSection', gid, name); const s = this.sectionsById.get(gid); if (!s) throw notFound('PUT', `/sections/${gid}`); s.name = name; return { gid, name }; }

  private view(r: Rec): AsTask {
    const kids = [...this.tasksById.values()].filter(t => t.parent === r.gid).length;
    return structuredClone({
      gid: r.gid, name: r.name, notes: r.notes, completed: r.completed, due_on: r.due_on, due_at: r.due_at, modified_at: new Date(r.modified).toISOString(),
      parent: r.parent ? { gid: r.parent, name: this.tasksById.get(r.parent)?.name } : null, num_subtasks: kids,
      memberships: r.memberships.map((m): AsMembership => ({ project: { gid: m.project, name: this.projectsById.get(m.project)?.name }, ...(m.section ? { section: { gid: m.section, name: this.sectionsById.get(m.section)?.name } } : {}) })),
      tags: r.tags.map(g => ({ gid: g, name: this.tagsById.get(g)?.name })),
    });
  }
  private since(rows: Rec[], completedSince?: string) {
    if (!completedSince) return rows;
    const at = completedSince === 'now' ? this.clock : Date.parse(completedSince);
    return rows.filter(r => !r.completed || (r.completedAt ?? 0) >= at);
  }
  async tasks(project: string, completedSince?: string) {
    this.enter('tasks', project); if (!this.projectsById.has(project)) throw notFound('GET', '/tasks', 'project: Not a recognized ID');
    return this.since([...this.tasksById.values()].filter(t => t.memberships.some(m => m.project === project)), completedSince).map(r => this.view(r));
  }
  async subtasks(parent: string, completedSince?: string) {
    this.enter('subtasks', parent); if (!this.tasksById.has(parent)) throw notFound('GET', `/tasks/${parent}/subtasks`);
    return this.since([...this.tasksById.values()].filter(t => t.parent === parent), completedSince).map(r => this.view(r));
  }
  async task(gid: string) { this.enter('task', gid); const r = this.tasksById.get(gid); return r ? this.view(r) : null; }
  private rec(gid: string, method: string, path: string) { const r = this.tasksById.get(gid); if (!r) throw notFound(method, path); return r; }
  private touch(r: Rec) { r.modified = this.clock = this.clock + 1000; }
  private apply(r: Rec, f: AsTaskFields) {
    if (f.name !== undefined) r.name = f.name; if (f.notes !== undefined) r.notes = f.notes;
    // Live probe 2026-11-17: writing due_on clears due_at.
    if (f.due_on !== undefined) { r.due_on = f.due_on; r.due_at = null; } if (f.due_at !== undefined) r.due_at = f.due_at;
    if (f.completed !== undefined && f.completed !== r.completed) { r.completed = f.completed; r.completedAt = f.completed ? this.clock : null; }
    this.touch(r);
  }
  /** As a user would in Asana: a top-level task in a project (and section). */
  add(project: string, fields: AsTaskFields & { name: string; section?: string }): AsTask {
    const { section, ...rest } = fields, r: Rec = { gid: this.id(), name: '', notes: '', completed: false, completedAt: null, due_on: null, due_at: null, modified: this.clock, parent: null, memberships: [{ project, ...(section ? { section } : {}) }], tags: [] };
    this.tasksById.set(r.gid, r); this.apply(r, rest); return this.view(r);
  }
  async createTask({ parent, projects, memberships, workspace: _w, ...fields }: AsNewTask) {
    this.enter('createTask', fields.name); if (parent && !this.tasksById.has(parent)) throw notFound('POST', `/tasks/${parent}/subtasks`);
    // Live probe 2026-11-17: memberships alone are refused; projects (or workspace) must come with them.
    if (!parent && !projects?.length && !_w) throw new AsHttpError(400, 'Asana POST /tasks: You should specify one of workspace, parent, projects');
    const r: Rec = { gid: this.id(), name: '', notes: '', completed: false, completedAt: null, due_on: null, due_at: null, modified: this.clock, parent: parent ?? null, memberships: parent ? [] : [...(projects ?? []).filter(project => !memberships?.some(m => m.project === project)).map(project => ({ project })), ...(memberships ?? []).map(m => ({ project: m.project, ...(m.section ? { section: m.section } : {}) }))], tags: [] };
    for (const m of parent ? [] : memberships ?? []) { if (!this.projectsById.has(m.project) || m.section && this.sectionsById.get(m.section)?.project !== m.project) throw new AsHttpError(400, 'Asana POST /tasks: memberships: Not a recognized ID'); }
    this.tasksById.set(r.gid, r); this.apply(r, fields); return this.view(r);
  }
  async updateTask(gid: string, fields: AsTaskFields) { this.enter('updateTask', gid); const r = this.rec(gid, 'PUT', `/tasks/${gid}`); this.apply(r, fields); return this.view(r); }
  async deleteTask(gid: string) { this.enter('deleteTask', gid); if (!this.tasksById.delete(gid)) throw notFound('DELETE', `/tasks/${gid}`, 'Unknown object'); }
  async addToSection(section: string, task: string) {
    this.enter('addToSection', section, task); const s = this.sectionsById.get(section); if (!s) throw notFound('POST', `/sections/${section}/addTask`);
    const r = this.rec(task, 'POST', `/sections/${section}/addTask`), m = r.memberships.find(x => x.project === s.project);
    if (m) m.section = section; else r.memberships.push({ project: s.project, section }); this.touch(r);
  }
  async addProject(task: string, project: string, section?: string) {
    this.enter('addProject', task, project); const r = this.rec(task, 'POST', `/tasks/${task}/addProject`); if (!this.projectsById.has(project)) throw notFound('POST', `/tasks/${task}/addProject`, 'project: Not a recognized ID');
    r.memberships = [...r.memberships.filter(m => m.project !== project), { project, ...(section ? { section } : {}) }]; this.touch(r);
  }
  async removeProject(task: string, project: string) { this.enter('removeProject', task, project); const r = this.rec(task, 'POST', `/tasks/${task}/removeProject`); r.memberships = r.memberships.filter(m => m.project !== project); this.touch(r); }
  async setParent(task: string, parent: string | null) {
    this.enter('setParent', task, parent ?? ''); const r = this.rec(task, 'POST', `/tasks/${task}/setParent`);
    if (parent !== null) { this.rec(parent, 'POST', `/tasks/${task}/setParent`); for (let at: string | null = parent; at; at = this.tasksById.get(at)?.parent ?? null) if (at === task) throw new AsHttpError(400, `Asana POST /tasks/${task}/setParent: parent: A task cannot be its own ancestor`); }
    r.parent = parent; this.touch(r);   // memberships are kept; null leaves the task wherever it was (none, after removeProject)
  }
  async tags(workspace: string) { this.enter('tags', workspace); return [...this.tagsById.values()].filter(t => t.workspace === workspace).map(t => ({ gid: t.gid, name: t.name })); }
  async createTag(workspace: string, name: string, color?: string) {
    this.enter('createTag', workspace, name); if (!workspace || !this.workspaces.has(workspace)) throw new AsHttpError(400, 'Asana POST /tags: You should specify one of workspace');
    if (color !== undefined && !TAG_COLORS.includes(color)) throw new AsHttpError(400, `Asana POST /tags: color: Invalid value: ${color}`);
    const t = { gid: this.id(), name, workspace, ...(color ? { color } : {}) }; this.tagsById.set(t.gid, t); return { gid: t.gid, name };
  }
  async addTag(task: string, tag: string) { this.enter('addTag', task, tag); const r = this.rec(task, 'POST', `/tasks/${task}/addTag`); if (!this.tagsById.has(tag)) throw notFound('POST', `/tasks/${task}/addTag`, 'tag: Not a recognized ID'); if (!r.tags.includes(tag)) r.tags.push(tag); this.touch(r); }
  async removeTag(task: string, tag: string) { this.enter('removeTag', task, tag); const r = this.rec(task, 'POST', `/tasks/${task}/removeTag`); r.tags = r.tags.filter(t => t !== tag); this.touch(r); }
  async webhooks(workspace: string, resource?: string) { this.enter('webhooks', workspace); return [...this.hooks.values()].filter(h => h.workspace === workspace && (!resource || h.resource?.gid === resource)).map(({ workspace: _w, ...h }) => structuredClone(h)); }
  async createWebhook(resource: string, target: string) {
    this.enter('createWebhook', resource, target); const workspace = this.projectsById.get(resource)?.workspaceGid ?? '';
    const h = { gid: this.id(), target, active: true, resource: { gid: resource }, workspace }; this.hooks.set(h.gid, h); const { workspace: _w, ...rest } = h; return structuredClone(rest);
  }
  async deleteWebhook(gid: string) { this.enter('deleteWebhook', gid); if (!this.hooks.delete(gid)) throw notFound('DELETE', `/webhooks/${gid}`); }
}
