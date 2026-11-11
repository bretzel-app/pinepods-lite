import { expect, it } from 'vitest';
import { lockIsFree } from './state';

it('a fresh lock blocks, a stale or missing one does not', () => {
  const now = 10 * 60 * 60_000;
  expect(lockIsFree(null, now)).toBe(true);
  expect(lockIsFree(now - 5 * 60_000, now)).toBe(false);
  expect(lockIsFree(now - 31 * 60_000, now)).toBe(true);
});
