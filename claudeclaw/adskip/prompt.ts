import type { SavedEpisode, Seg } from './types';

export const ADS_SCHEMA = {
  type: 'object',
  properties: {
    ads: {
      type: 'array',
      items: {
        type: 'object',
        properties: { start: { type: 'number' }, end: { type: 'number' }, label: { type: 'string' } },
        required: ['start', 'end', 'label'],
      },
    },
  },
  required: ['ads'],
};

// The prompt itself goes in on stdin.
export function claudeArgs(): string[] {
  return ['-p', '--model', 'sonnet', '--tools', '', '--strict-mcp-config',
    '--output-format', 'json', '--json-schema', JSON.stringify(ADS_SCHEMA)];
}

export function buildPrompt(ep: SavedEpisode, segments: Seg[]): string {
  const lines = segments.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`);
  return [
    `Below is the timestamped transcript of the podcast episode "${ep.title}" from "${ep.podcast}".`,
    'Find the advertisements and return their time ranges in seconds.',
    '',
    'Rules:',
    '- Injected ads in any language are ads.',
    '- Host-read sponsor segments (the host reading a sponsor message, promo code or offer) are ads.',
    '- Show content is not an ad, including the host talking about his own show, guests or episode.',
    '- If you are not sure a passage is an ad, leave it out.',
    '- Snap each range to segment boundaries: start at the start of the first ad segment and end at the end of the last.',
    '- Give each range a short label (for example the sponsor name).',
    '- If there are no ads, return an empty list.',
    '',
    'Transcript, one segment per line as [start-end] text:',
    ...lines,
  ].join('\n');
}
