import type { Account, Episode } from '../lib/types';
import { putLocalPosition } from '../lib/db';
import { recordListenDuration } from '../lib/api';
import { runOrQueue } from '../lib/sync';

export async function savePositionLocally(
  account: Account,
  ep: Episode,
  seconds: number,
  duration: number,
  synced: boolean,
): Promise<void> {
  await putLocalPosition({
    key: `${account.id}:${ep.episodeid}`,
    accountId: account.id,
    episodeId: ep.episodeid,
    seconds,
    duration,
    updatedAt: Date.now(),
    synced,
  });
}

export async function syncEpisodePosition(
  account: Account,
  ep: Episode,
  seconds: number,
  duration: number,
): Promise<void> {
  if (seconds <= 0) return;
  // Preview episodes (negative synthetic ids) don't exist on the server:
  // keep resume local-only.
  if (ep.episodeid < 0) {
    await savePositionLocally(account, ep, seconds, duration, false);
    return;
  }
  await savePositionLocally(account, ep, seconds, duration, true);
  await runOrQueue(account, { kind: 'record_position', episodeId: ep.episodeid, seconds }, () =>
    recordListenDuration(account, ep.episodeid, seconds),
  );
}
