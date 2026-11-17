import { describe, expect, it } from 'vitest';
import { Store } from '../../server/db';
import { Hub } from '../../server/hub';
import { emptyDoc } from '../../src/core/model/seed';
import { apply } from '../../src/core/commands/apply';

// Of /tasks, users submit only unbind; the task sync records the rest. A document never brings a binding.
describe('the hub and task sync', () => {
  it('refuses every /tasks action from a user except unbind and field', () => {
    const hub = new Hub(new Store(':memory:'));
    for (const action of ['add', 'bound', 'pull', 'links', 'gone', 'containers', 'relate', 'bind', 'sync', 'status'])
      expect(() => hub.submit('u1', 'web', crypto.randomUUID(), { verb: 'tasks', args: { action } }), action).toThrow('Invalid or privileged command');
    expect(() => hub.submit('u1', 'web', crypto.randomUUID(), { verb: 'tasks', args: { action: 'unbind' } })).toThrow('This map is not bound to a task service: /tasks bind "‹project›"');
    // A field switch is the user's too (D21): it reaches apply, which wants a binding.
    expect(() => hub.submit('u1', 'web', crypto.randomUUID(), { verb: 'tasks', args: { action: 'field', field: 'identity', on: false } })).toThrow('This map is not bound to a task service: /tasks bind "‹project›"');
  });
  it('drops the binding and remote ids from an imported document', () => {
    const hub = new Hub(new Store(':memory:'));
    const bound = apply(emptyDoc('UTC'), { verb: 'tasks', args: { action: 'bound', provider: 'fake', label: 'Fake', root: 'R1', title: 'Ops', containers: { work: 'C1' } } }, new Date());
    if ('error' in bound) throw new Error(bound.error);
    const doc = structuredClone(bound.doc);
    hub.import('u1', doc);
    expect(hub.doc.settings.taskSync).toBeUndefined();
    expect(hub.doc.sectors.some(s => s.remote !== undefined)).toBe(false);
  });
});
