// An in-memory Vikunja with the behavior the sync relies on (checked against Vikunja 2.8 on 2026-11-10):
// new projects get list and kanban views with To-Do, Doing and Done buckets, Done is the done bucket;
// marking a task done moves it to Done, undone moves it to the default bucket, and a project move puts the
// task in the new project's default bucket. `tick()` advances the clock that stamps `updated`.
import type { VkApi, VkBucket, VkLabel, VkProject, VkTask, VkView, VkWebhook } from '../../server/vikunja/api';

interface Board { view: VkView; buckets: VkBucket[] }
export class FakeVikunja implements VkApi {
  projectsById = new Map<number, VkProject>();
  boards = new Map<number, Board>();          // project id → its kanban
  tasksById = new Map<number, VkTask>();
  bucketOfTask = new Map<number, number>();
  hooks = new Map<number, VkWebhook[]>();
  calls: string[] = [];
  private nextId = 100;
  private clock = Date.now();
  private id() { return this.nextId++; }
  tick(ms = 1000) { this.clock += ms; return new Date(this.clock).toISOString(); }
  now() { return new Date(this.clock).toISOString(); }

  /** Tokens this Vikunja accepts. */
  tokens = new Set(['tk_good_token']);
  async me() { return { id: 1, username: 'alice' }; }
  async projects() { this.calls.push('projects'); return [...this.projectsById.values()].map(p => structuredClone(p)); }
  async createProject(title: string, parentId: number) {
    this.calls.push(`createProject ${title}`);
    const id = this.id(), list: VkView = { id: this.id(), view_kind: 'list', bucket_configuration_mode: 'none' };
    const kanban: VkView = { id: this.id(), view_kind: 'kanban', bucket_configuration_mode: 'manual' };
    const buckets = ['To-Do', 'Doing', 'Done'].map((t, i) => ({ id: this.id(), title: t, position: (i + 1) * 100 }));
    kanban.default_bucket_id = buckets[0].id; kanban.done_bucket_id = buckets[2].id;
    const p: VkProject = { id, title, parent_project_id: parentId, views: [list, kanban] };
    this.projectsById.set(id, p); this.boards.set(id, { view: kanban, buckets });
    return structuredClone(p);
  }
  private board(projectId: number, viewId: number) {
    const b = this.boards.get(projectId); if (!b || b.view.id !== viewId) throw new Error('No such view'); return b;
  }
  async buckets(projectId: number, viewId: number) { return structuredClone(this.board(projectId, viewId).buckets); }
  async createBucket(projectId: number, viewId: number, title: string, position?: number) {
    this.calls.push(`createBucket ${title}`);
    const b = { id: this.id(), title, position: position ?? 999999 }; this.board(projectId, viewId).buckets.push(b); return { ...b };
  }
  async tasks(projectId: number) { return [...this.tasksById.values()].filter(t => t.project_id === projectId).map(t => ({ ...structuredClone(t), bucket_id: 0 })); }
  async bucketsOfTasks(projectId: number) {
    const out = new Map<number, number>();
    for (const t of this.tasksById.values()) if (t.project_id === projectId) out.set(t.id, this.bucketOfTask.get(t.id)!);
    return out;
  }
  async task(id: number) { const t = this.tasksById.get(id); return t ? structuredClone(t) : null; }
  /** As a user in Vikunja's UI would: create a task in a project. */
  add(projectId: number, fields: Partial<VkTask>): VkTask {
    const t: VkTask = { id: this.id(), title: 'Task', description: '', done: false, due_date: '0001-01-01T00:00:00Z', percent_done: 0, project_id: projectId, updated: this.tick(), ...fields };
    this.tasksById.set(t.id, t);
    const b = this.boards.get(projectId)!;
    this.bucketOfTask.set(t.id, t.done ? b.view.done_bucket_id! : b.view.default_bucket_id!);
    return t;
  }
  /** As a user would: edit fields (done and project moves behave like Vikunja). */
  edit(id: number, fields: Partial<VkTask>): VkTask {
    const t = this.tasksById.get(id)!, before = { ...t };
    Object.assign(t, fields, { updated: this.tick() });
    const b = this.boards.get(t.project_id)!;
    if (t.project_id !== before.project_id) this.bucketOfTask.set(id, t.done ? b.view.done_bucket_id! : b.view.default_bucket_id!);
    else if (t.done && !before.done) this.bucketOfTask.set(id, b.view.done_bucket_id!);
    else if (!t.done && before.done) this.bucketOfTask.set(id, b.view.default_bucket_id!);
    return t;
  }
  /** As a user would: drag the card to a bucket (Done marks it done). */
  drag(id: number, bucketTitle: string) {
    const t = this.tasksById.get(id)!, b = this.boards.get(t.project_id)!, bucket = b.buckets.find(x => x.title === bucketTitle)!;
    this.bucketOfTask.set(id, bucket.id); t.done = bucket.id === b.view.done_bucket_id; t.updated = this.tick();
  }
  async createTask(projectId: number, fields: Partial<VkTask>) {
    this.calls.push(`createTask ${fields.title}`);
    return structuredClone(this.add(projectId, { ...fields, due_date: fields.due_date ?? '0001-01-01T00:00:00Z' }));
  }
  async updateTask(task: VkTask) {
    this.calls.push(`updateTask ${task.id}`);
    // Vikunja's task update ignores labels: they have their own endpoints.
    const { bucket_id: _ignored, updated: _u, labels: _l, ...fields } = task;
    return structuredClone(this.edit(task.id, { ...fields, due_date: fields.due_date ?? '0001-01-01T00:00:00Z' }));
  }
  async deleteTask(id: number) { this.calls.push(`deleteTask ${id}`); this.tasksById.delete(id); this.bucketOfTask.delete(id); }
  async moveToBucket(projectId: number, viewId: number, bucketId: number, taskId: number) {
    this.calls.push(`move ${taskId} ${this.board(projectId, viewId).buckets.find(b => b.id === bucketId)?.title}`);
    const b = this.board(projectId, viewId); this.bucketOfTask.set(taskId, bucketId);
    const t = this.tasksById.get(taskId)!; t.done = bucketId === b.view.done_bucket_id; t.updated = this.tick();
  }
  labelsById = new Map<number, VkLabel>();
  async labels() { return [...this.labelsById.values()].map(l => ({ ...l })); }
  async createLabel(title: string, hex_color: string) { this.calls.push(`createLabel ${title}`); const l = { id: this.id(), title, hex_color }; this.labelsById.set(l.id, l); return { ...l }; }
  async addLabel(taskId: number, labelId: number) {
    this.calls.push(`addLabel ${taskId} ${this.labelsById.get(labelId)?.title}`);
    const t = this.tasksById.get(taskId)!; t.labels = [...(t.labels ?? []), { ...this.labelsById.get(labelId)! }];
  }
  async removeLabel(taskId: number, labelId: number) {
    this.calls.push(`removeLabel ${taskId} ${this.labelsById.get(labelId)?.title}`);
    const t = this.tasksById.get(taskId)!; t.labels = (t.labels ?? []).filter(l => l.id !== labelId);
  }
  /** Label titles on a task. */
  labelsOf(taskId: number) { return (this.tasksById.get(taskId)!.labels ?? []).map(l => l.title).sort(); }
  /** As a user would: a label by title, made if missing. */
  label(title: string): VkLabel { const found = [...this.labelsById.values()].find(l => l.title === title); if (found) return found; const l = { id: this.id(), title }; this.labelsById.set(l.id, l); return l; }
  async webhooks(projectId: number) { return structuredClone(this.hooks.get(projectId) ?? []); }
  async createWebhook(projectId: number, target_url: string, events: string[]) {
    const w = { id: this.id(), target_url, events }; this.hooks.set(projectId, [...(this.hooks.get(projectId) ?? []), w]); return { ...w };
  }
  async deleteWebhook(projectId: number, id: number) { this.hooks.set(projectId, (this.hooks.get(projectId) ?? []).filter(w => w.id !== id)); }
  bucketTitle(taskId: number) {
    const t = this.tasksById.get(taskId)!; return this.boards.get(t.project_id)!.buckets.find(b => b.id === this.bucketOfTask.get(taskId))?.title;
  }
  child(rootTitle: string, title: string) {
    const root = [...this.projectsById.values()].find(p => p.title === rootTitle)!;
    return [...this.projectsById.values()].find(p => p.parent_project_id === root.id && p.title === title)!;
  }
}
