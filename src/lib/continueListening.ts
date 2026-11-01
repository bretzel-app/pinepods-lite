import type { Account, Episode } from './types';
import { cacheGet, cacheSet, getDownload, listLocalPositions } from './db';

/**
 * Builds the "Continue listening" list by merging two sources of truth:
 *  - server history (what other clients + past syncs recorded), and
 *  - the local positions store (progress made in this browser, including
 *    fully offline listening that hasn't reached the server yet).
 *
 * Episodes that are effectively finished — flagged completed, or with less
 * than a minute / 2% remaining — are filtered out even when the server
 * hasn't marked them completed.
 */

const MIN_LISTENED_SECONDS = 30;
const FINISHED_REMAINING_SECONDS = 60;
const FINISHED_FRACTION = 0.98;

/** Episode id -> when it was removed from Continue listening (ms). Local
 * only: the server has no notion of it. */
const DISMISSED_KEY = 'continue-dismissed';
type Dismissed = Record<string, number>;

/**
 * Hide an episode from Continue listening without touching its progress or
 * played state. It comes back as soon as it's listened to again (here or on
 * another client), since that activity is newer than the dismissal.
 */
export async function dismissFromContinueListening(
  accountId: string,
  episodeId: number,
  now = Date.now(),
): Promise<void> {
  const dismissed = (await cacheGet<Dismissed>(accountId, DISMISSED_KEY)) ?? {};
  dismissed[episodeId] = now;
  await cacheSet(accountId, DISMISSED_KEY, dismissed);
}

export function isEffectivelyFinished(ep: Episode, listened: number, duration: number): boolean {
  if (ep.completed) return true;
  if (duration <= 0) return false;
  return duration - listened <= FINISHED_REMAINING_SECONDS || listened / duration >= FINISHED_FRACTION;
}

/** Find episode metadata for a locally-tracked episode that isn't in the
 * server history yet: downloads first, then the per-episode cache, then the
 * cached feed lists. */
async function resolveEpisode(accountId: string, episodeId: number): Promise<Episode | undefined> {
  const download = await getDownload(accountId, episodeId);
  if (download) return download.episode;
  const single = await cacheGet<Episode>(accountId, `episode:${episodeId}`);
  if (single) return single;
  for (const listKey of ['recent-episodes', 'saved-episodes']) {
    const list = await cacheGet<Episode[]>(accountId, listKey);
    const found = list?.find((e) => e.episodeid === episodeId);
    if (found) return found;
  }
  return undefined;
}

export async function buildContinueListening(
  account: Account,
  history: Episode[],
  limit = 8,
): Promise<Episode[]> {
  interface Entry {
    ep: Episode;
    listened: number;
    duration: number;
    lastActivity: number;
  }
  const byId = new Map<number, Entry>();

  for (const ep of history) {
    byId.set(ep.episodeid, {
      ep,
      listened: ep.listenduration ?? 0,
      duration: ep.episodeduration || 0,
      lastActivity: ep.listendate ? Date.parse(ep.listendate) || 0 : 0,
    });
  }

  for (const pos of await listLocalPositions(account.id)) {
    const existing = byId.get(pos.episodeId);
    if (existing) {
      existing.listened = Math.max(existing.listened, pos.seconds);
      existing.duration = existing.duration || pos.duration || 0;
      existing.lastActivity = Math.max(existing.lastActivity, pos.updatedAt);
    } else {
      const ep = await resolveEpisode(account.id, pos.episodeId);
      if (!ep) continue;
      byId.set(pos.episodeId, {
        ep,
        listened: Math.max(pos.seconds, ep.listenduration ?? 0),
        duration: ep.episodeduration || pos.duration || 0,
        lastActivity: pos.updatedAt,
      });
    }
  }

  const dismissed = (await cacheGet<Dismissed>(account.id, DISMISSED_KEY)) ?? {};
  const isDismissed = (e: Entry) => {
    const at = dismissed[e.ep.episodeid];
    return at !== undefined && e.lastActivity <= at;
  };

  return [...byId.values()]
    .filter(
      (e) =>
        e.listened >= MIN_LISTENED_SECONDS &&
        !isEffectivelyFinished(e.ep, e.listened, e.duration) &&
        !isDismissed(e),
    )
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, limit)
    .map((e) => e.ep);
}
