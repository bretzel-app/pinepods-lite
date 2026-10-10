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
