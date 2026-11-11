import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './types';

vi.mock('./api', () => ({
  getGeneratedTranscript: vi.fn(),
  getEpisodeTranscriptSources: vi.fn(),
  fetchTranscriptContent: vi.fn(),
}));

import { fetchTranscriptContent, getEpisodeTranscriptSources, getGeneratedTranscript } from './api';
import { loadEpisodeTranscript } from './episodeTranscript';

const account = { id: 'a', serverUrl: 'https://pp', apiKey: 'k', userId: 2 } as Account;
const generated = vi.mocked(getGeneratedTranscript);
const sources = vi.mocked(getEpisodeTranscriptSources);
const content = vi.mocked(fetchTranscriptContent);

beforeEach(() => vi.resetAllMocks());

describe('loadEpisodeTranscript', () => {
  it("prefers PinePods' own transcript: its times fit the server copy", async () => {
    generated.mockResolvedValue([{ start: 0, text: 'hello' }]);
    expect(await loadEpisodeTranscript(account, 7)).toEqual([{ start: 0, text: 'hello' }]);
    expect(sources).not.toHaveBeenCalled();
  });

  it("falls back to the feed's transcript", async () => {
    generated.mockResolvedValue(null);
    sources.mockResolvedValue([{ url: 'https://cdn/7.srt', mime_type: 'application/srt', language: null, rel: null }]);
    content.mockResolvedValue('1\n00:00:01,000 --> 00:00:02,000\nfrom the feed\n');
    expect(await loadEpisodeTranscript(account, 7)).toEqual([{ start: 1, text: 'from the feed' }]);
  });

  it("still tries the feed when PinePods' transcript can't be read", async () => {
    generated.mockRejectedValue(new Error('404'));
    sources.mockResolvedValue([]);
    expect(await loadEpisodeTranscript(account, 7)).toBeNull();
  });

  it('is null when there is neither', async () => {
    generated.mockResolvedValue(null);
    sources.mockResolvedValue([]);
    expect(await loadEpisodeTranscript(account, 7)).toBeNull();
  });
});
