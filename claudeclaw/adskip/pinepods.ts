import type { CopyMatch, PinepodsApi, SavedEpisode, Seg, SkipView, TranscriptInfo } from './types';

export class PinepodsError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'PinepodsError';
    this.status = status;
  }
}

const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

export function pinepodsApi(
  baseUrl: string,
  apiKey: string,
  userId: number,
  fetchImpl: typeof fetch = fetch,
): PinepodsApi {
  const base = baseUrl.replace(/\/+$/, '');

  async function call(path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = { 'Api-Key': apiKey };
    const init: RequestInit = { headers };
    if (body !== undefined) {
      init.method = 'POST';
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetchImpl(base + path, init);
    } catch (e) {
      throw new PinepodsError(`PinePods ${path} unreachable: ${(e as Error).message}`);
    }
    if (!res.ok) throw new PinepodsError(`PinePods ${path} returned ${res.status}`, res.status);
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  return {
    async saved(): Promise<SavedEpisode[]> {
      const data = await call(`/api/data/saved_episode_list/${userId}`);
      const rows: any[] = Array.isArray(data?.saved_episodes) ? data.saved_episodes : [];
      return rows.map((r) => ({
        episodeId: Number(r.episodeid),
        title: String(r.episodetitle ?? ''),
        podcast: String(r.podcastname ?? ''),
        downloaded: truthy(r.downloaded),
        isYoutube: truthy(r.is_youtube),
        durationSec: Number(r.episodeduration) || 0,
      }));
    },
    async download(episodeId) {
      await call('/api/data/download_podcast', { episode_id: episodeId, user_id: userId, is_youtube: false });
    },
    async transcribe(episodeId, force) {
      await call('/api/data/transcribe_episode', { episode_id: episodeId, user_id: userId, force });
    },
    async transcript(episodeId): Promise<TranscriptInfo | null> {
      const data = await call(`/api/data/episode_transcript?episode_id=${episodeId}&user_id=${userId}`);
      const t = data?.transcript;
      if (!t) return null;
      let segments: Seg[] = [];
      try {
        const parsed = typeof t.segments === 'string' ? JSON.parse(t.segments) : t.segments;
        if (Array.isArray(parsed)) segments = parsed;
      } catch {
        segments = [];
      }
      return { status: t.status, segments };
    },
    async skips(episodeId): Promise<SkipView> {
      const data = await call(`/api/data/episode_skip_segments?episode_id=${episodeId}&user_id=${userId}`);
      const rows: any[] = Array.isArray(data?.segments) ? data.segments : [];
      const download = data?.ad_audio?.download;
      return {
        ads: rows.filter((s) => s.kind === 'ad').map((s) => ({ start: Number(s.start_time), end: Number(s.end_time) })),
        scanned: rows.some((s) => s.kind === 'ad-scan'),
        download: (download ?? null) as CopyMatch | null,
      };
    },
  };
}
