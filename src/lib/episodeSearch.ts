import type { Episode } from './types';
import { stripHtml } from './format';

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
