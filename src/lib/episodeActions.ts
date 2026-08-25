import type { Account, Episode } from './types';
import { markEpisodeCompleted, markEpisodeUncompleted } from './api';
import { cacheSet } from './db';
import { removeDownloadedEpisode } from './downloads';
import { runOrQueue } from './sync';

/**
 * Mark an episode completed (server-synced, queued while offline) and clean
 * up its local offline copy — a finished episode doesn't need audio on the
 * device. Used both when playback reaches the end and for the manual
 * "Mark played" action.
 */
export async function markCompleted(account: Account, episode: Episode): Promise<void> {
  const id = episode.episodeid;
  await runOrQueue(account, { kind: 'mark_completed', episodeId: id }, () =>
    markEpisodeCompleted(account, id),
  );
  await removeDownloadedEpisode(account, id);
  await cacheSet(account.id, `episode:${id}`, { ...episode, completed: true });
}

export async function markUncompleted(account: Account, episode: Episode): Promise<void> {
  const id = episode.episodeid;
  await runOrQueue(account, { kind: 'mark_uncompleted', episodeId: id }, () =>
    markEpisodeUncompleted(account, id),
  );
  await cacheSet(account.id, `episode:${id}`, { ...episode, completed: false });
}
