import type { Account, Episode } from './types';
import { markEpisodeCompleted, markEpisodeUncompleted } from './api';
import { cacheSet } from './db';
import { removeDownloadedEpisode } from './downloads';
import { runOrQueue } from './sync';

type CompletionListener = (accountId: string, episodeId: number, completed: boolean) => void;

const completionListeners = new Set<CompletionListener>();
// Played state set in this session, keyed `${accountId}:${episodeId}`. Lists
// render from cached responses that predate it, so it wins over theirs.
const completionOverrides = new Map<string, boolean>();

function setCompletion(accountId: string, episodeId: number, completed: boolean): void {
  completionOverrides.set(`${accountId}:${episodeId}`, completed);
  for (const listener of completionListeners) listener(accountId, episodeId, completed);
}

/** The episode's played state, including changes made since it was fetched. */
export function knownCompleted(accountId: string, episode: Episode): boolean {
  return completionOverrides.get(`${accountId}:${episode.episodeid}`) ?? episode.completed;
}

/** Hear about episodes marked played/unplayed (manually or by playback
 * reaching the end), so rows already on screen can update. */
export function subscribeCompletion(listener: CompletionListener): () => void {
  completionListeners.add(listener);
  return () => {
    completionListeners.delete(listener);
  };
}

/**
 * Mark an episode completed (server-synced, queued while offline) and clean
 * up its local offline copy — a finished episode doesn't need audio on the
 * device. Used both when playback reaches the end and for the manual
 * "Mark played" action.
 */
export async function markCompleted(account: Account, episode: Episode): Promise<void> {
  const id = episode.episodeid;
  setCompletion(account.id, id, true);
  await runOrQueue(account, { kind: 'mark_completed', episodeId: id }, () =>
    markEpisodeCompleted(account, id),
  );
  await removeDownloadedEpisode(account, id);
  await cacheSet(account.id, `episode:${id}`, { ...episode, completed: true });
}

export async function markUncompleted(account: Account, episode: Episode): Promise<void> {
  const id = episode.episodeid;
  setCompletion(account.id, id, false);
  await runOrQueue(account, { kind: 'mark_uncompleted', episodeId: id }, () =>
    markEpisodeUncompleted(account, id),
  );
  await cacheSet(account.id, `episode:${id}`, { ...episode, completed: false });
}
