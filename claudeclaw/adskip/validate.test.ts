import { describe, it, expect } from 'vitest';
import { InvalidOutput, parseClaudeResult, validateRanges, episodeLength } from './validate';
import type { SavedEpisode } from './types';

const ep: SavedEpisode = { episodeId: 12, title: 'Ep', podcast: 'Pod', downloaded: true, isYoutube: false, durationSec: 3600 };

describe('parseClaudeResult', () => {
  it('takes structured_output from the result', () => {
    expect(parseClaudeResult('{"type":"result","is_error":false,"structured_output":{"ads":[]}}')).toEqual({ ads: [] });
  });
  it('falls back to JSON in result', () => {
    expect(parseClaudeResult('{"type":"result","is_error":false,"result":"{\\"ads\\":[]}"}')).toEqual({ ads: [] });
  });
  it('rejects error results and non-JSON', () => {
    expect(() => parseClaudeResult('{"type":"result","is_error":true,"subtype":"error_max_structured_output_retries"}')).toThrow(InvalidOutput);
    expect(() => parseClaudeResult('nope')).toThrow(InvalidOutput);
  });
  it('rejects a result with neither structured_output nor parsable result', () => {
    expect(() => parseClaudeResult('{"type":"result","is_error":false}')).toThrow(InvalidOutput);
    expect(() => parseClaudeResult('{"type":"result","is_error":false,"result":"sorry"}')).toThrow(InvalidOutput);
  });
});

describe('validateRanges', () => {
  it('accepts, sorts and merges ranges', () => {
    expect(validateRanges({ ads: [{ start: 35, end: 60, label: 'b' }, { start: 10, end: 40, label: 'a' }] }, 3600))
      .toEqual([{ start: 10, end: 60, label: 'a' }]);
  });
  it('accepts an empty list', () => {
    expect(validateRanges({ ads: [] }, 3600)).toEqual([]);
  });
  it.each([
    [{ ads: [{ start: 40, end: 40, label: 'x' }] }],
    [{ ads: [{ start: -1, end: 5, label: 'x' }] }],
    [{ ads: [{ start: 10, end: 3700, label: 'x' }] }],
    [{ ads: [{ start: 0, end: 1801, label: 'x' }] }],
    [{ nope: true }],
  ])('rejects %j', (raw) => expect(() => validateRanges(raw, 3600)).toThrow(InvalidOutput));
});

describe('episodeLength', () => {
  it('uses the last segment end when the episode duration is 0', () => {
    expect(episodeLength({ ...ep, durationSec: 0 }, [{ start: 0, end: 10, text: '' }, { start: 10, end: 2400, text: '' }])).toBe(2400);
  });
  it('uses the episode duration when known', () => {
    expect(episodeLength(ep, [{ start: 0, end: 10, text: '' }])).toBe(3600);
  });
});
