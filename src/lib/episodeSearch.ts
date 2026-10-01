import type { Episode, Podcast } from './types';
import { stripHtml } from './format';
import { cacheGet, cacheListByPrefix, listDownloads } from './db';

/** Lowercase and strip accents so "eleve" matches "Élève". */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Pre-folded title + description text per episode, built once per list. */
export function buildSearchIndex(episodes: Episode[]): Map<number, string> {
  return new Map(
    episodes.map((e) => [
      e.episodeid,
      fold(`${e.episodetitle} ${stripHtml(e.episodedescription ?? '')}`),
    ]),
  );
}

/** Episodes whose title or description contains every word of the query. */
export function filterEpisodes(
  episodes: Episode[],
  index: Map<number, string>,
  query: string,
): Episode[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return episodes;
  return episodes.filter((e) => {
    const text = index.get(e.episodeid) ?? '';
    return words.every((w) => text.includes(w));
  });
}

/**
 * Offline fallback for searching all subscriptions: every episode list this
 * device has cached (podcast pages already opened, home feed, history, saved,
 * downloads), deduplicated and filtered like the in-podcast search.
 */
export async function searchCachedEpisodes(accountId: string, query: string): Promise<Episode[]> {
  const [perPodcast, recent, history, saved, downloads, pods] = await Promise.all([
    cacheListByPrefix<Episode[]>(accountId, 'podcast-episodes:'),
    cacheGet<Episode[]>(accountId, 'recent-episodes'),
    cacheGet<Episode[]>(accountId, 'history'),
    cacheGet<Episode[]>(accountId, 'saved-episodes'),
    listDownloads(accountId),
    cacheGet<Podcast[]>(accountId, 'podcasts'),
  ]);
  const names = new Map((pods ?? []).map((p) => [p.podcastid, p.podcastname]));

  const byId = new Map<number, Episode>();
  const add = (e: Episode, podcastid?: number) => {
    if (byId.has(e.episodeid)) return;
    const pid = e.podcastid ?? podcastid;
    byId.set(e.episodeid, {
      ...e,
      podcastid: pid,
      podcastname: e.podcastname || (pid != null ? names.get(pid) : undefined) || '',
    });
  };
  for (const { key, data } of perPodcast) {
    const pid = Number(key.slice('podcast-episodes:'.length));
    for (const e of data ?? []) add(e, pid);
  }
  for (const list of [recent, history, saved]) for (const e of list ?? []) add(e);
  for (const d of downloads) add(d.episode);

  const time = (e: Episode) => Date.parse(e.episodepubdate) || 0;
  const all = [...byId.values()].sort((a, b) => time(b) - time(a));
  return filterEpisodes(all, buildSearchIndex(all), query);
}
