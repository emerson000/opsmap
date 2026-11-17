// Links into a task service, from its descriptor's URL templates ({root}, {container}, {id}). The UI never builds a
// service URL any other way, so a new service brings its links as data.
import type { ProviderDescriptor } from '../sync/protocol';

const fill = (template: string, values: { root?: string; container?: string; id?: string }) =>
  template.replace(/\{(root|container|id)\}/g, (_, key: 'root' | 'container' | 'id') => encodeURIComponent(values[key] ?? ''));
/** A task (a unit's remote id) in the bound root. */
export function taskUrl(d: ProviderDescriptor, root: string, id: string): string { return fill(d.urls.task, { root, id }); }
/** A container (a sector's remote id) in the bound root, or undefined when the service has no container link. */
export function containerUrl(d: ProviderDescriptor, root: string, id: string): string | undefined { return d.urls.container ? fill(d.urls.container, { root, container: id }) : undefined; }
/** The bound root itself. */
export function rootUrl(d: ProviderDescriptor, root: string): string { return fill(d.urls.root, { root }); }
