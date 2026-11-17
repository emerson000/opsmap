import { describe, expect, it } from 'vitest';
import { deliverySummary, shortEvery, webhooksBlocked, webhooksBlockedWhy } from '../../server/tasksync/delivery';
import type { Capabilities } from '../../server/tasksync/contract';

// The one-line delivery mode the sidebar shows (from the /tasks status answer), with the full reason for its tooltip.
const caps = (webhooks: Capabilities['webhooks']): Capabilities => ({ fields: new Set(), relations: new Set(), maxTitle: 250, maxNote: 1000, webhooks, pollMs: 120_000, idlePollMs: 600_000 });
const cloud = caps({ https: true, publicAddress: true }), lan = caps({ https: false, publicAddress: false });

describe('delivery summary', () => {
  it('says how often it checks, and why webhooks are off', () => {
    expect(shortEvery(120_000)).toBe('2 min');
    expect(shortEvery(15_000)).toBe('15 s');
    expect(deliverySummary({ mode: 'live', reason: 'Fake delivers changes', nextPollMs: 600_000 }, 3)).toEqual({ mode: 'live', summary: 'Live updates', reason: 'Fake delivers changes' });
    expect(deliverySummary({ mode: 'pending', reason: 'no webhooks yet', nextPollMs: 120_000 }, 0).summary).toBe('Checking every 2 min');
    expect(deliverySummary({ mode: 'pending', reason: '3 webhooks registered, none delivered in the last 15 minutes', nextPollMs: 120_000 }, 3).summary).toBe('Checking every 2 min: webhooks not delivering yet');
    expect(deliverySummary({ mode: 'failed', reason: 'refused', nextPollMs: 60_000 }, 0).summary).toBe('Checking every 1 min: webhooks failed');
    const reach = { https: true, publicAddress: false, reason: 'PUBLIC_URL is a private address (100.101.1.2)' };
    const why = webhooksBlockedWhy('auto', 'https://opsmap.example.ts.net', reach, cloud, 'Fake')!;
    expect(why).toEqual({ reason: 'PUBLIC_URL is a private address (100.101.1.2): Fake needs a public HTTPS address', note: 'webhooks off on a private address' });
    expect(deliverySummary({ mode: 'off', reason: why.reason, nextPollMs: 120_000 }, 0, why.note)).toEqual({ mode: 'off', summary: 'Checking every 2 min: webhooks off on a private address', reason: why.reason });
  });
  it('keeps the status reasons as they were', () => {
    expect(webhooksBlocked('off', 'https://x.example', undefined, lan, 'Fake')).toBe('webhooks are off (TASKSYNC_WEBHOOKS=off)');
    expect(webhooksBlockedWhy('off', 'https://x.example', undefined, lan, 'Fake')?.note).toBe('webhooks off');
    expect(webhooksBlockedWhy('auto', undefined, undefined, lan, 'Fake')).toEqual({ reason: 'webhooks need PUBLIC_URL to be an address Fake can reach', note: 'webhooks off without PUBLIC_URL' });
    expect(webhooksBlockedWhy('auto', 'http://127.0.0.1', { https: false, publicAddress: false, loopback: true }, lan, 'Fake')?.note).toBe('webhooks off on a private address');
    expect(webhooksBlockedWhy('auto', 'http://x.example', { https: false, publicAddress: true }, cloud, 'Fake')?.note).toBe('webhooks off without HTTPS');
    expect(webhooksBlockedWhy('auto', 'http://192.168.1.2', { https: false, publicAddress: false }, lan, 'Fake')).toBeUndefined();
    expect(webhooksBlockedWhy('auto', 'https://x.example', undefined, caps(false), 'Fake')?.reason).toBe('Fake has no webhooks');
  });
});
