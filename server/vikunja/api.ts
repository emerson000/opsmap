// Vikunja REST API (v1 paths, Vikunja 2.x), only the calls the sync needs. The sync talks to `VkApi`, so tests
// can use an in-memory fake.

export interface VkView { id: number; view_kind: 'list' | 'gantt' | 'table' | 'kanban'; bucket_configuration_mode?: string; done_bucket_id?: number; default_bucket_id?: number; }
export interface VkProject { id: number; title: string; parent_project_id: number; is_archived?: boolean; views?: VkView[] | null; }
export interface VkBucket { id: number; title: string; position?: number; }
export interface VkTask {
  id: number; title: string; description: string; done: boolean; due_date: string | null; percent_done: number;
  project_id: number; bucket_id?: number; updated: string; labels?: VkLabel[] | null; [key: string]: unknown;
}
export interface VkLabel { id: number; title: string; hex_color?: string }
export interface VkWebhook { id: number; target_url: string; events: string[]; }

export interface VkApi {
  /** The token's Vikunja user. */
  me(): Promise<{ id: number; username: string; name?: string }>;
  projects(): Promise<VkProject[]>;
  createProject(title: string, parentId: number): Promise<VkProject>;
  buckets(projectId: number, viewId: number): Promise<VkBucket[]>;
  createBucket(projectId: number, viewId: number, title: string, position?: number): Promise<VkBucket>;
  /** Every task of a project (list view, all pages). */
  tasks(projectId: number, listViewId: number): Promise<VkTask[]>;
  /** Task id → bucket id, from the kanban view. */
  bucketsOfTasks(projectId: number, kanbanViewId: number): Promise<Map<number, number>>;
  task(id: number): Promise<VkTask | null>;
  createTask(projectId: number, fields: Partial<VkTask>): Promise<VkTask>;
  /** Vikunja replaces the whole task on update, so callers pass the full task with their changes. */
  updateTask(task: VkTask): Promise<VkTask>;
  deleteTask(id: number): Promise<void>;
  moveToBucket(projectId: number, viewId: number, bucketId: number, taskId: number): Promise<void>;
  /** Every label the token's user can see. */
  labels(): Promise<VkLabel[]>;
  createLabel(title: string, hexColor: string): Promise<VkLabel>;
  addLabel(taskId: number, labelId: number): Promise<void>;
  removeLabel(taskId: number, labelId: number): Promise<void>;
  webhooks(projectId: number): Promise<VkWebhook[]>;
  createWebhook(projectId: number, targetUrl: string, events: string[], secret: string): Promise<VkWebhook>;
  deleteWebhook(projectId: number, webhookId: number): Promise<void>;
}

export class VkHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class HttpVkApi implements VkApi {
  private readonly base: string;
  constructor(url: string, private readonly key: string, private readonly timeoutMs = 15000) {
    this.base = `${url.replace(/\/+$/, '')}/api/v1`;
  }
  private async call<T>(method: string, path: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const res = await fetch(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `${res.status}`;
      try { message = (JSON.parse(text) as { message?: string }).message ?? message; } catch { /* not JSON */ }
      throw new VkHttpError(res.status, `Vikunja ${method} ${path.split('?')[0]}: ${message}`);
    }
    return { data: (text ? JSON.parse(text) : null) as T, headers: res.headers };
  }
  async me() { return (await this.call<{ id: number; username: string; name?: string }>('GET', '/user')).data; }
  /** Every project, all pages, archived ones too (an archived sector project is still part of the A/O). */
  async projects() {
    const out: VkProject[] = [];
    for (let page = 1; page <= 100; page++) {
      const { data, headers } = await this.call<VkProject[]>('GET', `/projects?page=${page}&per_page=50&is_archived=true`);
      out.push(...(data ?? []));
      if (page >= Number(headers.get('x-pagination-total-pages') ?? 1)) break;
    }
    return out;
  }
  async createProject(title: string, parentId: number) { return (await this.call<VkProject>('PUT', '/projects', { title, parent_project_id: parentId })).data; }
  async buckets(projectId: number, viewId: number) { return (await this.call<VkBucket[]>('GET', `/projects/${projectId}/views/${viewId}/buckets`)).data ?? []; }
  async createBucket(projectId: number, viewId: number, title: string, position?: number) {
    return (await this.call<VkBucket>('PUT', `/projects/${projectId}/views/${viewId}/buckets`, { title, ...(position === undefined ? {} : { position }) })).data;
  }
  async tasks(projectId: number, listViewId: number) {
    const out: VkTask[] = [];
    for (let page = 1; page <= 100; page++) {
      const { data, headers } = await this.call<VkTask[]>('GET', `/projects/${projectId}/views/${listViewId}/tasks?page=${page}&per_page=50`);
      out.push(...(data ?? []));
      if (page >= Number(headers.get('x-pagination-total-pages') ?? 1)) break;
    }
    return out;
  }
  async bucketsOfTasks(projectId: number, kanbanViewId: number) {
    const { data } = await this.call<{ id: number; tasks?: { id: number }[] | null }[]>('GET', `/projects/${projectId}/views/${kanbanViewId}/tasks?per_page=50`);
    const out = new Map<number, number>();
    for (const bucket of data ?? []) for (const t of bucket.tasks ?? []) out.set(t.id, bucket.id);
    return out;
  }
  async task(id: number) {
    try { return (await this.call<VkTask>('GET', `/tasks/${id}`)).data; }
    catch (error) { if (error instanceof VkHttpError && (error.status === 404 || error.status === 403)) return null; throw error; }
  }
  async createTask(projectId: number, fields: Partial<VkTask>) { return (await this.call<VkTask>('PUT', `/projects/${projectId}/tasks`, fields)).data; }
  async updateTask(task: VkTask) { return (await this.call<VkTask>('POST', `/tasks/${task.id}`, task)).data; }
  async deleteTask(id: number) { await this.call('DELETE', `/tasks/${id}`); }
  async moveToBucket(projectId: number, viewId: number, bucketId: number, taskId: number) {
    await this.call('POST', `/projects/${projectId}/views/${viewId}/buckets/${bucketId}/tasks`, { task_id: taskId });
  }
  async labels() {
    const out: VkLabel[] = [];
    for (let page = 1; page <= 50; page++) {
      const { data, headers } = await this.call<VkLabel[]>('GET', `/labels?page=${page}&per_page=50`);
      out.push(...(data ?? []));
      if (page >= Number(headers.get('x-pagination-total-pages') ?? 1)) break;
    }
    return out;
  }
  async createLabel(title: string, hexColor: string) { return (await this.call<VkLabel>('PUT', '/labels', { title, hex_color: hexColor })).data; }
  async addLabel(taskId: number, labelId: number) { await this.call('PUT', `/tasks/${taskId}/labels`, { label_id: labelId }); }
  async removeLabel(taskId: number, labelId: number) { await this.call('DELETE', `/tasks/${taskId}/labels/${labelId}`); }
  async webhooks(projectId: number) { return (await this.call<VkWebhook[]>('GET', `/projects/${projectId}/webhooks`)).data ?? []; }
  async createWebhook(projectId: number, targetUrl: string, events: string[], secret: string) {
    return (await this.call<VkWebhook>('PUT', `/projects/${projectId}/webhooks`, { target_url: targetUrl, events, secret })).data;
  }
  async deleteWebhook(projectId: number, webhookId: number) { await this.call('DELETE', `/projects/${projectId}/webhooks/${webhookId}`); }
}
