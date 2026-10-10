import type { Episode } from './types';

/** The list an episode was started from; previous/next walk it in order. */
export interface PlayQueue {
  /** Shown in the player, e.g. "Downloads" or the podcast's name. */
  source: string;
  episodes: Episode[];
}

/** Oldest first. Feeds list newest first, so reversing before the (stable)
 * sort keeps same-date episodes in a sensible order; undated episodes sort
 * first. */
export function chronological(list: Episode[]): Episode[] {
  const time = (e: Episode) => Date.parse(e.episodepubdate) || 0;
  return [...list].reverse().sort((a, b) => time(a) - time(b));
}

/** Each podcast's episodes oldest first, podcasts in the order they first
 * appear. For mixed lists like Downloads, where "next" should continue the
 * same show's story rather than jump to whatever another show published in
 * between. */
export function chronologicalByPodcast(list: Episode[]): Episode[] {
  const groups = new Map<string | number, Episode[]>();
  for (const e of list) {
    const key = e.podcastid ?? e.podcastname;
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }
  return [...groups.values()].flatMap(chronological);
}
