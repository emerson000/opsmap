import { describe, expect, it } from 'vitest';
import { containerUrl, rootUrl, taskUrl } from '../../src/lib/ui/taskUrls';
import type { ProviderDescriptor } from '../../src/lib/sync/protocol';

const d: ProviderDescriptor = { id: 'fake', label: 'Fake', aliases: [], rootNoun: 'project', containerNoun: 'section', tokenHelp: '', fields: [],
  urls: { root: 'http://fake.invalid/{root}', container: 'http://fake.invalid/{root}/{container}', task: 'http://fake.invalid/{root}/task/{id}' } };

describe('task service links', () => {
  it('fills the descriptor templates, encoding each id', () => {
    expect(taskUrl(d, 'R1', 'T 2')).toBe('http://fake.invalid/R1/task/T%202');
    expect(containerUrl(d, 'R1', 'C/3')).toBe('http://fake.invalid/R1/C%2F3');
    expect(rootUrl(d, 'R1')).toBe('http://fake.invalid/R1');
  });
  it('has no container link when the service has none', () => {
    expect(containerUrl({ ...d, urls: { root: d.urls.root, task: d.urls.task } }, 'R1', 'C3')).toBeUndefined();
  });
});
