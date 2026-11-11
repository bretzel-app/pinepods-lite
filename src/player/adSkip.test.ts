import { describe, it, expect } from 'vitest';
import { AdSkipper } from './adSkip';

const s = () => {
  const k = new AdSkipper();
  k.setRanges([[10, 40], [90, 120]]);
  return k;
};

describe('AdSkipper', () => {
  it('jumps to the end of the range', () => expect(s().target(15, 3600)).toBe(40));
  it('leaves other positions alone', () => expect(s().target(50, 3600)).toBeNull());
  it('ignores the last 0.25 s of a range', () => expect(s().target(39.8, 3600)).toBeNull());
  it('a range reaching the end jumps to the end', () => {
    const k = new AdSkipper();
    k.setRanges([[3500, 3600]]);
    expect(k.target(3550, 3600)).toBe(3600);
    k.setRanges([[3500, 3599.5]]);
    expect(k.target(3550, 3600)).toBe(3600);
  });
  it('a manual seek into a range plays it', () => {
    const k = s();
    k.onUserSeek(20);
    expect(k.target(25, 3600)).toBeNull();
  });
  it('skipping resumes at the next range', () => {
    const k = s();
    k.onUserSeek(20);
    k.target(41, 3600);
    expect(k.target(95, 3600)).toBe(120);
  });
  it('a seek outside any range clears the exemption', () => {
    const k = s();
    k.onUserSeek(20);
    k.onUserSeek(60);
    expect(k.target(25, 3600)).toBe(40);
  });
  it('a position reached without a manual seek is skipped (resume point inside an ad)', () =>
    expect(s().target(12, 3600)).toBe(40));
  it('setRanges clears the manual-seek exemption', () => {
    const k = s();
    k.onUserSeek(20);
    k.setRanges([[10, 40]]);
    expect(k.target(25, 3600)).toBe(40);
  });
});
