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

/** Transcript segments (a JSON string of `[{start, end, text}]`); none yet while it is being made. */
function parseSegments(episodeId: number, raw: unknown): Seg[] {
  if (raw === null || raw === undefined || raw === '') return [];
  const bad = (why: string) => new PinepodsError(`PinePods transcript of episode ${episodeId}: ${why}`);
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw bad('segments are not JSON');
    }
  }
  if (!Array.isArray(parsed)) throw bad('segments are not a list');
  return parsed.map((s: any) => {
    if (!s || typeof s.start !== 'number' || typeof s.end !== 'number' || !Number.isFinite(s.start) || !Number.isFinite(s.end)) {
      throw bad('a segment has no numeric start/end');
    }
    return { start: s.start, end: s.end, text: typeof s.text === 'string' ? s.text : String(s.text ?? '') };
  });
}

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
    try {
      return JSON.parse(text);
    } catch {
      // Not PinePods answering (a wrong PINEPODS_URL), which must not pass for "nothing there".
      throw new PinepodsError(`PinePods ${path} answered ${res.status} without JSON; check PINEPODS_URL`, res.status);
    }
  }

  return {
    async saved(): Promise<SavedEpisode[]> {
      const data = await call(`/api/data/saved_episode_list/${userId}`);
      if (!Array.isArray(data?.saved_episodes)) throw new PinepodsError('PinePods saved_episode_list has no saved_episodes list');
      const rows: any[] = data.saved_episodes;
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
      return { status: t.status, segments: parseSegments(episodeId, t.segments) };
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
