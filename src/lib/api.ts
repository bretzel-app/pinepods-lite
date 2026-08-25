import type { Account, Episode, Podcast, SearchResult } from './types';

/**
 * Thin typed client for the PinePods HTTP API (Rust/Axum backend).
 * Auth model: GET /api/data/get_key with Basic auth returns a long-lived
 * API key; every other call sends it in the `Api-Key` header.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export function normalizeServerUrl(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

async function request<T>(
  account: Pick<Account, 'serverUrl' | 'apiKey'>,
  path: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${account.serverUrl}${path}`, {
      ...init,
      headers: {
        'Api-Key': account.apiKey,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (e) {
    throw new ApiError(`Network error: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new ApiError(`${res.status} ${res.statusText} for ${path}`, res.status);
  }
  return (await res.json()) as T;
}

// ---- auth ------------------------------------------------------------------

export interface LoginResult {
  serverUrl: string;
  apiKey: string;
  userId: number;
  mfaRequired: boolean;
}

/** Exchange username/password for an API key. */
export async function login(
  serverUrl: string,
  username: string,
  password: string,
): Promise<LoginResult> {
  const base = normalizeServerUrl(serverUrl);
  let res: Response;
  try {
    res = await fetch(`${base}/api/data/get_key`, {
      headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` },
    });
  } catch (e) {
    throw new ApiError(
      `Could not reach ${base} — check the server URL and your connection. (${(e as Error).message})`,
    );
  }
  if (res.status === 401) throw new ApiError('Invalid username or password', 401);
  if (!res.ok) throw new ApiError(`Server error: ${res.status} ${res.statusText}`, res.status);
  const body = (await res.json()) as {
    status: string;
    retrieved_key?: string | null;
    user_id?: number | null;
    mfa_required?: boolean | null;
  };
  if (body.mfa_required) {
    return { serverUrl: base, apiKey: '', userId: body.user_id ?? 0, mfaRequired: true };
  }
  if (body.status !== 'success' || !body.retrieved_key || body.user_id == null) {
    throw new ApiError(`Login failed: ${body.status}`);
  }
  return { serverUrl: base, apiKey: body.retrieved_key, userId: body.user_id, mfaRequired: false };
}

export async function verifyKey(account: Pick<Account, 'serverUrl' | 'apiKey'>): Promise<boolean> {
  try {
    const body = await request<{ status: string }>(account, '/api/data/verify_key');
    return body.status === 'success';
  } catch {
    return false;
  }
}

export interface UserDetails {
  username: string;
  fullname: string;
}

export async function getUserDetails(
  account: Pick<Account, 'serverUrl' | 'apiKey'>,
  userId: number,
): Promise<UserDetails> {
  const raw = await request<Record<string, unknown>>(
    account,
    `/api/data/user_details_id/${userId}`,
  );
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;
  return {
    username: String(lower.username ?? ''),
    fullname: String(lower.fullname ?? lower.username ?? ''),
  };
}

// ---- episodes normalization -------------------------------------------------

/** The API returns episode objects with inconsistent key casing depending on
 * the endpoint (episodetitle vs Episodetitle vs Listenduration). Fold every
 * key to lowercase and map to our Episode type. */
export function normalizeEpisode(raw: Record<string, unknown>): Episode {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) r[k.toLowerCase()] = v;
  return {
    episodeid: Number(r.episodeid ?? 0),
    episodetitle: String(r.episodetitle ?? ''),
    podcastid: r.podcastid != null ? Number(r.podcastid) : undefined,
    podcastname: String(r.podcastname ?? ''),
    episodepubdate: String(r.episodepubdate ?? ''),
    episodedescription: String(r.episodedescription ?? ''),
    episodeartwork: String(r.episodeartwork ?? ''),
    episodeurl: String(r.episodeurl ?? ''),
    episodeduration: Number(r.episodeduration ?? 0),
    listenduration: r.listenduration != null ? Number(r.listenduration) : null,
    listendate: r.listendate != null ? String(r.listendate) : null,
    completed: Boolean(r.completed),
    saved: Boolean(r.saved),
    queued: Boolean(r.queued),
    downloaded: Boolean(r.downloaded),
    is_youtube: Boolean(r.is_youtube),
  };
}

// ---- podcasts & episodes -----------------------------------------------------

export async function getSubscribedPodcasts(account: Account): Promise<Podcast[]> {
  const body = await request<{ pods: Podcast[] }>(
    account,
    `/api/data/return_pods/${account.userId}`,
  );
  return body.pods ?? [];
}

export async function getPodcastEpisodes(
  account: Account,
  podcastId: number,
  limit = 100,
  offset = 0,
): Promise<{ episodes: Episode[]; total: number }> {
  const body = await request<{ episodes: Record<string, unknown>[]; total: number }>(
    account,
    `/api/data/podcast_episodes?user_id=${account.userId}&podcast_id=${podcastId}&limit=${limit}&offset=${offset}`,
  );
  return { episodes: (body.episodes ?? []).map(normalizeEpisode), total: body.total ?? 0 };
}

/** Recent episodes across all subscriptions (the home feed). */
export async function getRecentEpisodes(
  account: Account,
  limit = 50,
  offset = 0,
): Promise<{ episodes: Episode[]; total: number }> {
  const body = await request<{ episodes: Record<string, unknown>[]; total: number }>(
    account,
    `/api/data/return_episodes/${account.userId}?limit=${limit}&offset=${offset}`,
  );
  return { episodes: (body.episodes ?? []).map(normalizeEpisode), total: body.total ?? 0 };
}

export interface AddPodcastInput {
  title: string;
  artwork: string;
  author: string;
  categories: Record<string, string>;
  description: string;
  episodeCount: number;
  feedUrl: string;
  website: string;
  explicit: boolean;
  indexId?: number;
}

export async function addPodcast(
  account: Account,
  pod: AddPodcastInput,
): Promise<{ success: boolean; podcast_id: number }> {
  return request(account, '/api/data/add_podcast', {
    method: 'POST',
    body: JSON.stringify({
      podcast_values: {
        pod_title: pod.title,
        pod_artwork: pod.artwork,
        pod_author: pod.author,
        categories: pod.categories,
        pod_description: pod.description,
        pod_episode_count: pod.episodeCount,
        pod_feed_url: pod.feedUrl,
        pod_website: pod.website,
        pod_explicit: pod.explicit,
        user_id: account.userId,
      },
      podcast_index_id: pod.indexId ?? null,
    }),
  });
}

export async function removePodcast(account: Account, podcastId: number): Promise<void> {
  await request(account, '/api/data/remove_podcast_id', {
    method: 'POST',
    body: JSON.stringify({ user_id: account.userId, podcast_id: podcastId }),
  });
}

// ---- search ------------------------------------------------------------------

/** Search the Podcast Index through the server-side proxy. */
export async function searchPodcasts(account: Account, query: string): Promise<SearchResult[]> {
  const body = await request<{
    feeds?: Record<string, unknown>[];
    results?: Record<string, unknown>[];
  }>(
    account,
    `/api/data/proxy_search?query=${encodeURIComponent(query)}&index=podcast_index`,
  );
  const feeds = body.feeds ?? [];
  return feeds.map((f) => ({
    indexId: Number(f.id ?? 0),
    title: String(f.title ?? ''),
    feedUrl: String(f.url ?? f.originalUrl ?? ''),
    description: String(f.description ?? ''),
    author: String(f.author ?? f.ownerName ?? ''),
    artwork: String(f.artwork ?? f.image ?? ''),
    website: String(f.link ?? ''),
    explicit: Boolean(f.explicit),
    episodeCount: Number(f.episodeCount ?? 0),
    categories: (f.categories ?? {}) as Record<string, string>,
  }));
}

// ---- feed preview (episodes of a podcast the user hasn't subscribed to) --------

export interface FeedEpisode {
  title: string | null;
  description: string | null;
  pub_date: string;
  enclosure_url: string | null;
  artwork: string | null;
  content: string | null;
  duration: number;
  guid: string;
  is_video: boolean;
}

/** Server-side RSS parse of an arbitrary feed — no subscription required. */
export async function fetchPodcastFeed(
  account: Account,
  feedUrl: string,
): Promise<FeedEpisode[]> {
  const body = await request<{ episodes: FeedEpisode[] }>(
    account,
    `/api/data/fetch_podcast_feed?podcast_feed=${encodeURIComponent(feedUrl)}`,
  );
  return body.episodes ?? [];
}

/** Stable negative id for a preview episode (real server ids are positive).
 * The player persists local resume positions under it but never syncs
 * negative ids to the server. */
export function previewEpisodeId(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return -(Math.abs(h) || 1);
}

// ---- transcripts (Podcasting 2.0 feed transcripts) ------------------------------

export interface TranscriptSource {
  url: string | null;
  mime_type: string | null;
  language: string | null;
  rel: string | null;
}

/** Transcript files the podcast's feed declares for this episode. */
export async function getEpisodeTranscriptSources(
  account: Account,
  episodeId: number,
): Promise<TranscriptSource[]> {
  const body = await request<{ transcripts?: TranscriptSource[] }>(
    account,
    `/api/data/fetch_podcasting_2_data?episode_id=${episodeId}&user_id=${account.userId}`,
  );
  return (body.transcripts ?? []).filter((t) => t.url);
}

/** Download a transcript file through the server's CORS-friendly proxy. */
export async function fetchTranscriptContent(
  account: Account,
  url: string,
): Promise<string | null> {
  const body = await request<{ success: boolean; content?: string }>(
    account,
    '/api/data/fetch_transcript',
    { method: 'POST', body: JSON.stringify({ url }) },
  );
  return body.success && body.content ? body.content : null;
}

// ---- favorites (saved episodes) ------------------------------------------------

export async function getSavedEpisodes(account: Account): Promise<Episode[]> {
  const body = await request<{ saved_episodes: Record<string, unknown>[] }>(
    account,
    `/api/data/saved_episode_list/${account.userId}`,
  );
  return (body.saved_episodes ?? []).map(normalizeEpisode).map((e) => ({ ...e, saved: true }));
}

export async function saveEpisode(account: Account, episodeId: number): Promise<void> {
  await request(account, '/api/data/save_episode', {
    method: 'POST',
    body: JSON.stringify({ episode_id: episodeId, user_id: account.userId, is_youtube: false }),
  });
}

export async function unsaveEpisode(account: Account, episodeId: number): Promise<void> {
  await request(account, '/api/data/remove_saved_episode', {
    method: 'POST',
    body: JSON.stringify({ episode_id: episodeId, user_id: account.userId, is_youtube: false }),
  });
}

// ---- playback progress ----------------------------------------------------------

export async function recordListenDuration(
  account: Account,
  episodeId: number,
  seconds: number,
): Promise<void> {
  await request(account, '/api/data/record_listen_duration', {
    method: 'POST',
    body: JSON.stringify({
      episode_id: episodeId,
      user_id: account.userId,
      listen_duration: seconds,
      is_youtube: false,
    }),
  });
}

export async function markEpisodeCompleted(account: Account, episodeId: number): Promise<void> {
  await request(account, '/api/data/mark_episode_completed', {
    method: 'POST',
    body: JSON.stringify({ episode_id: episodeId, user_id: account.userId, is_youtube: false }),
  });
}

export async function markEpisodeUncompleted(account: Account, episodeId: number): Promise<void> {
  await request(account, '/api/data/mark_episode_uncompleted', {
    method: 'POST',
    body: JSON.stringify({ episode_id: episodeId, user_id: account.userId, is_youtube: false }),
  });
}

export async function getUserHistory(account: Account, limit = 50): Promise<Episode[]> {
  const body = await request<{ data?: Record<string, unknown>[] } | Record<string, unknown>[]>(
    account,
    `/api/data/user_history/${account.userId}?limit=${limit}`,
  );
  const rows = Array.isArray(body) ? body : (body.data ?? []);
  return rows.map(normalizeEpisode);
}

// ---- server-side download (used as a CORS-safe audio source) ---------------------

/** Ask the server to download the episode file onto its own disk. */
export async function requestServerDownload(account: Account, episodeId: number): Promise<void> {
  await request(account, '/api/data/download_podcast', {
    method: 'POST',
    body: JSON.stringify({ episode_id: episodeId, user_id: account.userId, is_youtube: false }),
  });
}

export async function getEpisodeMetadata(account: Account, episodeId: number): Promise<Episode> {
  const body = await request<{ episode: Record<string, unknown> }>(
    account,
    '/api/data/get_episode_metadata',
    {
      method: 'POST',
      body: JSON.stringify({ episode_id: episodeId, user_id: account.userId, is_youtube: false }),
    },
  );
  return normalizeEpisode(body.episode ?? (body as unknown as Record<string, unknown>));
}

/** URL that streams a server-side-downloaded episode; served with CORS. */
export function serverStreamUrl(account: Account, episodeId: number): string {
  return `${account.serverUrl}/api/data/stream/${episodeId}?api_key=${encodeURIComponent(account.apiKey)}&user_id=${account.userId}`;
}
