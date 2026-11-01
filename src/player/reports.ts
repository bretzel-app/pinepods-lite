import type { Account, Episode } from '../lib/types';
import type { PlaybackReport } from './engine/types';

interface ReportDeps {
  accounts: Account[];
  syncPosition(a: Account, ep: Episode, seconds: number, duration: number): Promise<void>;
  markCompleted(a: Account, ep: Episode): Promise<void>;
}

/** Replays journal reports the engine recorded (possibly while the UI was
 * gone) in `seq` order. Returns the highest seq seen so the caller can ack. */
export async function applyReports(reports: PlaybackReport[], deps: ReportDeps): Promise<number> {
  const ordered = [...reports].sort((a, b) => a.seq - b.seq);
  const endedAt = new Map<string, number>();
  for (const r of ordered) if (r.kind === 'ended') endedAt.set(r.key, r.seq);

  let maxSeq = 0;
  for (const r of ordered) {
    maxSeq = Math.max(maxSeq, r.seq);
    const account = deps.accounts.find((a) => a.id === r.accountId);
    if (!account) continue;
    // An ended report carries the final position; an earlier position is stale.
    if (r.kind === 'position' && (endedAt.get(r.key) ?? 0) > r.seq) continue;
    try {
      if (r.kind === 'position') {
        await deps.syncPosition(account, r.episode, r.seconds, r.episode.episodeduration);
      } else {
        await deps.syncPosition(account, r.episode, r.seconds, r.seconds);
        // Preview episodes (negative ids) don't exist on the server.
        if (!r.episode.completed && r.episode.episodeid > 0) await deps.markCompleted(account, r.episode);
      }
    } catch (err) {
      console.warn('Could not apply playback report', r.seq, err);
    }
  }
  return maxSeq;
}
