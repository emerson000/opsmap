import { describe, expect, it } from 'vitest';
import { deliverySummary, shortEvery, webhooksBlocked, webhooksBlockedWhy } from '../../server/tasksync/delivery';
import type { Capabilities } from '../../server/tasksync/contract';

// The one-line delivery mode the sidebar shows (from the /tasks status answer), with the full reason for its tooltip.
const caps = (webhooks: Capabilities['webhooks']): Capabilities => ({ fields: new Set(), relations: new Set(), maxTitle: 250, maxNote: 1000, webhooks, pollMs: 120_000, idlePollMs: 600_000 });
const cloud = caps({ https: true, publicAddress: true }), lan = caps({ https: false, publicAddress: false });

describe('delivery summary', () => {
  it('says how often it checks, and in plain words why updates are not instant', () => {
    expect(shortEvery(120_000)).toBe('2 min');
    expect(shortEvery(15_000)).toBe('15 s');
    expect(deliverySummary({ mode: 'live', reason: 'Fake delivers changes', nextPollMs: 600_000 }, 3)).toEqual({ mode: 'live', summary: 'Live updates', reason: 'Fake delivers changes' });
    expect(deliverySummary({ mode: 'pending', reason: 'no webhooks yet', nextPollMs: 120_000 }, 0).summary).toBe('Checking every 2 min.');
    expect(deliverySummary({ mode: 'pending', reason: '3 webhooks registered, none delivered in the last 15 minutes', nextPollMs: 120_000 }, 3).summary).toBe('Checking every 2 min. Waiting for the first instant update.');
    expect(deliverySummary({ mode: 'failed', reason: 'refused', nextPollMs: 60_000 }, 0).summary).toBe('Checking every 1 min. Instant updates failed; trying again later.');
    const reach = { https: true, publicAddress: false, reason: 'PUBLIC_URL is a private address (100.101.1.2)' };
    const why = webhooksBlockedWhy('auto', 'https://opsmap.example.ts.net', reach, cloud, 'Fake')!;
    expect(why).toEqual({ reason: 'webhooks off: Fake needs a public HTTPS address; PUBLIC_URL is a private address (100.101.1.2)', note: 'Instant updates need a public HTTPS address.' });
    expect(deliverySummary({ mode: 'off', reason: why.reason, nextPollMs: 120_000 }, 0, why.note)).toEqual({ mode: 'off', summary: 'Checking every 2 min. Instant updates need a public HTTPS address.', reason: why.reason });
  });
  it('keeps the status reasons as they were', () => {
    expect(webhooksBlocked('off', 'https://x.example', undefined, lan, 'Fake')).toBe('webhooks are off (TASKSYNC_WEBHOOKS=off)');
    expect(webhooksBlockedWhy('off', 'https://x.example', undefined, lan, 'Fake')?.note).toBe('Instant updates are turned off on this server.');
    expect(webhooksBlockedWhy('auto', undefined, undefined, lan, 'Fake')).toEqual({ reason: 'webhooks need PUBLIC_URL to be an address Fake can reach', note: 'Instant updates need a public address for this server.' });
    expect(webhooksBlockedWhy('auto', 'http://127.0.0.1', { https: false, publicAddress: false, loopback: true }, lan, 'Fake')?.note).toBe('Instant updates need an address Fake can reach.');
    expect(webhooksBlockedWhy('auto', 'http://x.example', { https: false, publicAddress: true }, cloud, 'Fake')?.note).toBe('Instant updates need an HTTPS address.');
    expect(webhooksBlockedWhy('auto', 'http://192.168.1.2', { https: false, publicAddress: false }, lan, 'Fake')).toBeUndefined();
    expect(webhooksBlockedWhy('auto', 'https://x.example', undefined, caps(false), 'Fake')?.reason).toBe('Fake has no webhooks');
  });
});
