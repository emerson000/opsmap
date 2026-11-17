import { describe, expect, it } from 'vitest';
import { seedDoc } from '../../src/core/model/seed';
import { toSidc } from '../../src/core/model/sidc';

const now = new Date('2026-11-09T17:00:00Z');
const status = (sidc: string) => sidc[6];

describe('blocked status in the SIDC', () => {
  it('a blocked unit shows the slash, also when assessed fully capable; damaged and destroyed keep their own marks', () => {
    const u = seedDoc(now).units.find(x => x.designation === 'RECORDS')!;
    expect(status(toSidc({ ...u, lifecycle: 'blocked' }))).toBe('3');
    expect(status(toSidc({ ...u, lifecycle: 'blocked', condition: 'fully-capable' }))).toBe('3');
    expect(status(toSidc({ ...u, lifecycle: 'blocked', condition: 'destroyed' }))).toBe('4');
    expect(status(toSidc({ ...u, lifecycle: 'active', condition: 'fully-capable' }))).toBe('2');
  });
});
