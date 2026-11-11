import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGeneratedTranscript, normalizeEpisode } from './api';
import type { Account } from './types';

describe('normalizeEpisode', () => {
  it('reads the flags of list rows', () => {
    const ep = normalizeEpisode({ episodeid: 7, saved: 1, queued: 1, downloaded: 1 });
    expect(ep).toMatchObject({ saved: true, queued: true, downloaded: true });
  });

  // get_episode_metadata names them is_saved / is_queued / is_downloaded.
  it('reads the flags of episode metadata', () => {
    const ep = normalizeEpisode({ episodeid: 7, is_saved: true, is_queued: true, is_downloaded: true });
    expect(ep).toMatchObject({ saved: true, queued: true, downloaded: true });
  });

  it('defaults missing flags to false', () => {
    expect(normalizeEpisode({ episodeid: 7 })).toMatchObject({ saved: false, queued: false, downloaded: false });
  });
});

describe('getGeneratedTranscript', () => {
  const account = { id: 'a', serverUrl: 'https://pp', apiKey: 'k', userId: 2 } as Account;
  const answer = (body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  afterEach(() => vi.unstubAllGlobals());

  it('returns the segments of a complete transcript', async () => {
    answer({ transcript: { status: 'complete', segments: '[{"start":0,"end":2.5,"text":" hi "},{"start":2.5,"end":3,"text":"  "}]' } });
    expect(await getGeneratedTranscript(account, 7)).toEqual([{ start: 0, text: 'hi' }]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://pp/api/data/episode_transcript?episode_id=7&user_id=2');
  });

  it('is null while there is none or it is not complete', async () => {
    answer({ transcript: null });
    expect(await getGeneratedTranscript(account, 7)).toBeNull();
    answer({ transcript: { status: 'running', segments: null } });
    expect(await getGeneratedTranscript(account, 7)).toBeNull();
  });

  it('is null when the segments are not readable', async () => {
    answer({ transcript: { status: 'complete', segments: 'nope' } });
    expect(await getGeneratedTranscript(account, 7)).toBeNull();
  });
});
