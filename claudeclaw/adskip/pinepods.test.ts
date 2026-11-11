import { describe, it, expect } from 'vitest';
import { pinepodsApi, PinepodsError } from './pinepods';

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeFetch(routes: Record<string, unknown>, status = 200) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace('http://pp', '');
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const payload = path in routes ? routes[path] : {};
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch & { calls: Call[] };
  f.calls = calls;
  return f;
}

describe('pinepodsApi', () => {
  it('lists saved episodes with the Api-Key header', async () => {
    const f = fakeFetch({ '/api/data/saved_episode_list/7': { saved_episodes: [
      { episodeid: 12, episodetitle: 'Ep', podcastname: 'Huberman Lab', downloaded: 1, is_youtube: 0, episodeduration: 3600 }] } });
    const eps = await pinepodsApi('http://pp', 'k', 7, f).saved();
    expect(eps).toEqual([{ episodeId: 12, title: 'Ep', podcast: 'Huberman Lab', downloaded: true, isYoutube: false, durationSec: 3600 }]);
    expect(f.calls[0].headers['Api-Key']).toBe('k');
  });
  it('accepts boolean flags in saved rows', async () => {
    const f = fakeFetch({ '/api/data/saved_episode_list/7': { saved_episodes: [
      { episodeid: 1, episodetitle: 'A', podcastname: 'P', downloaded: false, is_youtube: true, episodeduration: 5 }] } });
    const [e] = await pinepodsApi('http://pp', 'k', 7, f).saved();
    expect(e.downloaded).toBe(false);
    expect(e.isYoutube).toBe(true);
  });
  it('parses the transcript segments string', async () => {
    const f = fakeFetch({ '/api/data/episode_transcript?episode_id=12&user_id=7':
      { transcript: { status: 'complete', segments: '[{"start":0,"end":2.5,"text":"hi"}]' } } });
    expect(await pinepodsApi('http://pp', 'k', 7, f).transcript(12))
      .toEqual({ status: 'complete', segments: [{ start: 0, end: 2.5, text: 'hi' }] });
  });
  it('returns null when there is no transcript', async () => {
    const f = fakeFetch({ '/api/data/episode_transcript?episode_id=12&user_id=7': { transcript: null } });
    expect(await pinepodsApi('http://pp', 'k', 7, f).transcript(12)).toBeNull();
  });
  it('reads ads, the scan marker and the copy match', async () => {
    const f = fakeFetch({ '/api/data/episode_skip_segments?episode_id=12&user_id=7': { segments: [
      { segment_id: 1, kind: 'ad', start_time: 10, end_time: 40, source: 'auto-ad', status: 'active' },
      { segment_id: 2, kind: 'ad-scan', start_time: 0, end_time: 0, source: 'auto-ad', status: null },
      { segment_id: 3, kind: 'silence', start_time: 50, end_time: 52, source: 'silence', status: null }],
      ad_audio: { analyzed: { fingerprint: 'f' }, download: 'match' } } });
    expect(await pinepodsApi('http://pp', 'k', 7, f).skips(12))
      .toEqual({ ads: [{ start: 10, end: 40 }], scanned: true, download: 'match' });
  });
  it('reports no scan and a null copy match when nothing is there', async () => {
    const f = fakeFetch({ '/api/data/episode_skip_segments?episode_id=12&user_id=7': { segments: [], ad_audio: null } });
    expect(await pinepodsApi('http://pp', 'k', 7, f).skips(12))
      .toEqual({ ads: [], scanned: false, download: null });
  });
  it('posts download and transcribe requests', async () => {
    const f = fakeFetch({});
    const api = pinepodsApi('http://pp', 'k', 7, f);
    await api.download(12);
    await api.transcribe(12, true);
    expect(f.calls[0].url).toBe('http://pp/api/data/download_podcast');
    expect(f.calls[0].method).toBe('POST');
    expect(f.calls[0].body).toEqual({ episode_id: 12, user_id: 7, is_youtube: false });
    expect(f.calls[1].url).toBe('http://pp/api/data/transcribe_episode');
    expect(f.calls[1].body).toEqual({ episode_id: 12, user_id: 7, force: true });
    expect(f.calls[1].headers['Api-Key']).toBe('k');
  });
  it('throws PinepodsError with the status on non-2xx', async () => {
    const f = fakeFetch({}, 500);
    const err = await pinepodsApi('http://pp', 'k', 7, f).saved().catch((e) => e);
    expect(err).toBeInstanceOf(PinepodsError);
    expect(err.status).toBe(500);
  });
});
