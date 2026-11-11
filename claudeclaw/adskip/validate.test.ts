import { describe, it, expect } from 'vitest';
import { ClaudeUnavailable, InvalidOutput, claudeStdout, parseClaudeResult, validateRanges, episodeLength } from './validate';
import type { SavedEpisode } from './types';

const ep: SavedEpisode = { episodeId: 12, title: 'Ep', podcast: 'Pod', downloaded: true, isYoutube: false, durationSec: 3600 };

describe('parseClaudeResult', () => {
  it('takes structured_output from the result', () => {
    expect(parseClaudeResult('{"type":"result","is_error":false,"structured_output":{"ads":[]}}')).toEqual({ ads: [] });
  });
  it('falls back to JSON in result', () => {
    expect(parseClaudeResult('{"type":"result","is_error":false,"result":"{\\"ads\\":[]}"}')).toEqual({ ads: [] });
  });
  it('rejects non-JSON as invalid output', () => {
    expect(() => parseClaudeResult('nope')).toThrow(InvalidOutput);
  });
  it('treats an error result as Claude being unavailable', () => {
    const usageLimit = '{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached"}';
    expect(() => parseClaudeResult(usageLimit)).toThrow(ClaudeUnavailable);
    expect(() => parseClaudeResult('{"type":"result","subtype":"error_during_execution","is_error":true}')).toThrow(ClaudeUnavailable);
  });
  it('treats an answer that never matched the schema as invalid output', () => {
    expect(() => parseClaudeResult('{"type":"result","is_error":true,"subtype":"error_max_structured_output_retries"}')).toThrow(InvalidOutput);
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
  it('applies the 50% cap to the merged ranges', () => {
    // Each under half of the episode, together over it.
    expect(() => validateRanges({ ads: [{ start: 0, end: 1000, label: 'a' }, { start: 900, end: 1900, label: 'b' }] }, 3600))
      .toThrow(InvalidOutput);
    expect(validateRanges({ ads: [{ start: 0, end: 1000, label: 'a' }, { start: 900, end: 1800, label: 'b' }] }, 3600))
      .toEqual([{ start: 0, end: 1800, label: 'a' }]);
  });
  it('accepts a post-roll past the feed duration that is inside the transcript', () => {
    // The transcript is of the server's copy, longer than the feed says (inserted ads).
    const segments = [{ start: 0, end: 10, text: '' }, { start: 3700, end: 3900, text: 'post-roll' }];
    expect(validateRanges({ ads: [{ start: 3700, end: 3900, label: 'x' }] }, episodeLength(ep, segments)))
      .toEqual([{ start: 3700, end: 3900, label: 'x' }]);
  });
});

describe('episodeLength', () => {
  it('uses the last segment end when the episode duration is 0', () => {
    expect(episodeLength({ ...ep, durationSec: 0 }, [{ start: 0, end: 10, text: '' }, { start: 10, end: 2400, text: '' }])).toBe(2400);
  });
  it('uses the episode duration when the transcript is shorter', () => {
    expect(episodeLength(ep, [{ start: 0, end: 10, text: '' }])).toBe(3600);
  });
  it('uses the transcript when it runs past the feed duration', () => {
    expect(episodeLength(ep, [{ start: 0, end: 10, text: '' }, { start: 10, end: 3900, text: '' }])).toBe(3900);
  });
});

describe('claudeStdout', () => {
  const run = { code: 0, timedOut: false, stdout: '{"type":"result"}', stderr: '', timeoutMs: 300_000 };
  it('returns the output of a clean exit', () => {
    expect(claudeStdout(run)).toBe('{"type":"result"}');
  });
  it('treats a timeout as Claude being unavailable', () => {
    expect(() => claudeStdout({ ...run, code: null, timedOut: true })).toThrow(ClaudeUnavailable);
    expect(() => claudeStdout({ ...run, code: null, timedOut: true })).toThrow('timed out after 300 s');
  });
  it('treats a non-zero exit without a result as Claude being unavailable', () => {
    expect(() => claudeStdout({ ...run, code: 1, stdout: '', stderr: 'Invalid API key · Please run /login' }))
      .toThrow(/exited with code 1: Invalid API key/);
  });
  it('passes on the error result of a non-zero exit, for parseClaudeResult to classify', () => {
    const limit = '{"type":"result","subtype":"success","is_error":true,"result":"usage limit"}';
    expect(() => parseClaudeResult(claudeStdout({ ...run, code: 1, stdout: limit }))).toThrow(ClaudeUnavailable);
    const retries = '{"type":"result","subtype":"error_max_structured_output_retries","is_error":true}';
    expect(() => parseClaudeResult(claudeStdout({ ...run, code: 1, stdout: retries }))).toThrow(InvalidOutput);
  });
  it('does not take a non-zero exit with a non-error result as success', () => {
    expect(() => claudeStdout({ ...run, code: 1, stdout: '{"type":"result","is_error":false,"structured_output":{"ads":[]}}' }))
      .toThrow(ClaudeUnavailable);
  });
});
