// Asana REST API (1.0), only the calls the adapter needs. The adapter talks to `AsApi`, so tests can use an in-memory fake.
// Behavior notes come from the 2026-11-17 spike: project task lists omit plain subtasks (use `subtasks`), a plain subtask has no memberships.

export interface AsRef { gid: string; name?: string }
export interface AsMembership { project?: AsRef; section?: AsRef }
export interface AsTask {
  gid: string; name: string; notes: string; completed: boolean; due_on: string | null; due_at: string | null; modified_at: string;
  parent: AsRef | null; num_subtasks: number; memberships: AsMembership[]; tags: AsRef[];
}
export interface AsProject { gid: string; name: string; archived?: boolean; workspace?: AsRef }
export interface AsSection { gid: string; name: string }
export interface AsTag { gid: string; name: string }
export interface AsWebhook { gid: string; target: string; active?: boolean; resource?: AsRef }
export interface AsUser { gid: string; name: string; workspaces: AsRef[] }
/** Fields a caller may write. `completed` and dates follow Asana: `due_on` is a day, `null` clears it. */
export interface AsTaskFields { name?: string; notes?: string; completed?: boolean; due_on?: string | null; due_at?: string | null }
export interface AsNewTask extends AsTaskFields { name: string; /** Makes a subtask (`POST /tasks/{parent}/subtasks`). */ parent?: string; /** Projects to put it in (top-level tasks only). */ projects?: string[];
  /** Project and section to put it in (top-level tasks only): a task made with `projects` alone may land in no section. */ memberships?: { project: string; section?: string }[]; workspace?: string }

export const TASK_FIELDS = 'name,notes,completed,due_on,due_at,modified_at,parent,num_subtasks,memberships.section,memberships.project,tags.name';

export interface AsApi {
  /** The token's user and the workspaces it can see. */
  me(): Promise<AsUser>;
  projects(workspace: string): Promise<AsProject[]>;
  project(gid: string): Promise<AsProject>;
  createProject(workspace: string, name: string): Promise<AsProject>;
  sections(project: string): Promise<AsSection[]>;
  createSection(project: string, name: string): Promise<AsSection>;
  renameSection(gid: string, name: string): Promise<AsSection>;
  /** Top-level tasks of a project plus multi-homed subtasks, never plain subtasks. With `completedSince`: open tasks and those completed at or after it. */
  tasks(project: string, completedSince?: string): Promise<AsTask[]>;
  /** The children of one task (one request per parent). */
  subtasks(parent: string, completedSince?: string): Promise<AsTask[]>;
  /** `null` when the task is gone (404). */
  task(gid: string): Promise<AsTask | null>;
  createTask(fields: AsNewTask): Promise<AsTask>;
  updateTask(gid: string, fields: AsTaskFields): Promise<AsTask>;
  deleteTask(gid: string): Promise<void>;
  addToSection(section: string, task: string): Promise<void>;
  /** Puts the task in a project (and section); a subtask becomes multi-homed. */
  addProject(task: string, project: string, section?: string): Promise<void>;
  removeProject(task: string, project: string): Promise<void>;
  /** Keeps the task's memberships. `null` makes it top-level, with no membership until `addProject`. */
  setParent(task: string, parent: string | null): Promise<void>;
  tags(workspace: string): Promise<AsTag[]>;
  /** A tag needs its workspace. `color`: an Asana color name such as `light-red`. */
  createTag(workspace: string, name: string, color?: string): Promise<AsTag>;
  addTag(task: string, tag: string): Promise<void>;
  removeTag(task: string, tag: string): Promise<void>;
  webhooks(workspace: string, resource?: string): Promise<AsWebhook[]>;
  createWebhook(resource: string, target: string): Promise<AsWebhook>;
  deleteWebhook(gid: string): Promise<void>;
}

const e = encodeURIComponent;
export class AsHttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterS?: number) { super(message); }
}

export class HttpAsApi implements AsApi {
  private readonly base: string;
  /** The token is only held here and sent as a Bearer header; it is never logged or put in an error. */
  #token: string;
  constructor(token: string, base = 'https://app.asana.com/api/1.0', private readonly timeoutMs = 15000) { this.#token = token; this.base = base.replace(/\/+$/, ''); }
  private async call<T>(method: string, path: string, body?: unknown): Promise<{ data: T; next: string | null }> {
    const res = await fetch(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify({ data: body }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: { data?: T; errors?: { message?: string }[]; next_page?: { offset?: string } | null } = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!res.ok) {
      const retry = Number(res.headers.get('retry-after'));
      throw new AsHttpError(res.status, `Asana ${method} ${path.split('?')[0]}: ${json.errors?.[0]?.message ?? res.status}`, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    return { data: json.data as T, next: json.next_page?.offset ?? null };
  }
  private async list<T>(path: string): Promise<T[]> {
    const out: T[] = [], max = 200;
    for (let offset: string | null = null, i = 0; ; i++) {
      if (i >= max) throw new Error(`Asana GET ${path.split('?')[0]}: more than ${max} pages`);
      const { data, next }: { data: T[]; next: string | null } = await this.call<T[]>('GET', `${path}${path.includes('?') ? '&' : '?'}limit=100${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`);
      out.push(...(data ?? []));
      if (!next) return out;
      if (next === offset) throw new Error(`Asana GET ${path.split('?')[0]}: the same page offset came back twice`);
      offset = next;
    }
  }
  private q(params: Record<string, string | undefined>) { return new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]).toString(); }
  me() { return this.call<AsUser>('GET', `/users/me?${this.q({ opt_fields: 'name,workspaces.name' })}`).then(r => r.data); }
  projects(workspace: string) { return this.list<AsProject>(`/projects?${this.q({ workspace, opt_fields: 'name,archived,workspace.name' })}`); }
  project(gid: string) { return this.call<AsProject>('GET', `/projects/${e(gid)}?${this.q({ opt_fields: 'name,archived,workspace.name' })}`).then(r => r.data); }
  createProject(workspace: string, name: string) { return this.call<AsProject>('POST', '/projects', { name, workspace }).then(r => r.data); }
  sections(project: string) { return this.list<AsSection>(`/projects/${e(project)}/sections?${this.q({ opt_fields: 'name' })}`); }
  createSection(project: string, name: string) { return this.call<AsSection>('POST', `/projects/${e(project)}/sections`, { name }).then(r => r.data); }
  renameSection(gid: string, name: string) { return this.call<AsSection>('PUT', `/sections/${e(gid)}`, { name }).then(r => r.data); }
  tasks(project: string, completedSince?: string) { return this.list<AsTask>(`/tasks?${this.q({ project, completed_since: completedSince, opt_fields: TASK_FIELDS })}`); }
  subtasks(parent: string, completedSince?: string) { return this.list<AsTask>(`/tasks/${e(parent)}/subtasks?${this.q({ completed_since: completedSince, opt_fields: TASK_FIELDS })}`); }
  async task(gid: string) {
    try { return (await this.call<AsTask>('GET', `/tasks/${e(gid)}?${this.q({ opt_fields: TASK_FIELDS })}`)).data; }
    catch (error) { if (error instanceof AsHttpError && error.status === 404) return null; throw error; }
  }
  createTask({ parent, projects, memberships, workspace, ...fields }: AsNewTask) { return this.call<AsTask>('POST', parent ? `/tasks/${e(parent)}/subtasks?${this.q({ opt_fields: TASK_FIELDS })}` : `/tasks?${this.q({ opt_fields: TASK_FIELDS })}`, parent ? fields : { ...fields, ...(projects ? { projects } : {}), ...(memberships ? { memberships } : {}), ...(workspace ? { workspace } : {}) }).then(r => r.data); }
  updateTask(gid: string, fields: AsTaskFields) { return this.call<AsTask>('PUT', `/tasks/${e(gid)}?${this.q({ opt_fields: TASK_FIELDS })}`, fields).then(r => r.data); }
  async deleteTask(gid: string) { await this.call('DELETE', `/tasks/${e(gid)}`); }
  async addToSection(section: string, task: string) { await this.call('POST', `/sections/${e(section)}/addTask`, { task }); }
  async addProject(task: string, project: string, section?: string) { await this.call('POST', `/tasks/${e(task)}/addProject`, { project, ...(section ? { section } : {}) }); }
  async removeProject(task: string, project: string) { await this.call('POST', `/tasks/${e(task)}/removeProject`, { project }); }
  async setParent(task: string, parent: string | null) { await this.call('POST', `/tasks/${e(task)}/setParent`, { parent }); }
  tags(workspace: string) { return this.list<AsTag>(`/tags?${this.q({ workspace, opt_fields: 'name' })}`); }
  createTag(workspace: string, name: string, color?: string) { return this.call<AsTag>('POST', '/tags', { name, workspace, ...(color ? { color } : {}) }).then(r => r.data); }
  async addTag(task: string, tag: string) { await this.call('POST', `/tasks/${e(task)}/addTag`, { tag }); }
  async removeTag(task: string, tag: string) { await this.call('POST', `/tasks/${e(task)}/removeTag`, { tag }); }
  webhooks(workspace: string, resource?: string) { return this.list<AsWebhook>(`/webhooks?${this.q({ workspace, resource, opt_fields: 'target,active,resource.name' })}`); }
  createWebhook(resource: string, target: string) { return this.call<AsWebhook>('POST', '/webhooks', { resource, target }).then(r => r.data); }
  async deleteWebhook(gid: string) { await this.call('DELETE', `/webhooks/${e(gid)}`); }
}
