import { describe, it, expect } from 'vitest';
import { ADS_SCHEMA, buildPrompt, claudeArgs } from './prompt';
import type { SavedEpisode } from './types';

const ep: SavedEpisode = { episodeId: 12, title: 'Ep', podcast: 'Pod', downloaded: true, isYoutube: false, durationSec: 3600 };

describe('prompt', () => {
  it('passes the prompt on stdin, not as an argument', () => {
    expect(claudeArgs()).toEqual(['-p', '--model', 'sonnet', '--tools', '', '--strict-mcp-config',
      '--output-format', 'json', '--json-schema', JSON.stringify(ADS_SCHEMA)]);
  });
  it('lists every segment with its times and states the rules', () => {
    const p = buildPrompt(ep, [{ start: 0, end: 2.5, text: 'hi' }, { start: 2.5, end: 61, text: 'AG1 sponsor' }]);
    expect(p).toContain('[0.0-2.5] hi');
    expect(p).toContain('[2.5-61.0] AG1 sponsor');
    expect(p).toMatch(/host-read/i);
    expect(p).toMatch(/not sure|unsure/i);
  });
});
