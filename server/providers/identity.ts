// The names a task service's identity tags or labels go by, shared by the adapters: the first name is the one an
// adapter creates; every name is read (case-insensitively). Each adapter picks its own colors.
import type { Affiliation } from '../../src/core/model/types';
export const IDENTITY_NAMES: Record<Affiliation, string[]> = {
  hostile: ['hostile', 'enemy'], suspect: ['suspect'], friend: ['friendly', 'friend'], assumed: ['assumed', 'assumed friend'],
  neutral: ['neutral'], unknown: ['unknown'], pending: ['pending'],
};
/** The identity a tag or label name stands for, if any. */
export const affiliationOfName = (name: string): Affiliation | undefined => {
  const n = name.trim().toLowerCase();
  return (Object.keys(IDENTITY_NAMES) as Affiliation[]).find(a => IDENTITY_NAMES[a].includes(n));
};
