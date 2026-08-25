import type { Account, PendingOp } from './types';
import { deleteOp, listOps, queueOp } from './db';
import { markEpisodeCompleted, recordListenDuration, saveEpisode, unsaveEpisode } from './api';

/**
 * Offline mutation queue. Any write that fails because the network is down is
 * stored and replayed the next time we're online (or when the app regains
 * focus). Ops are idempotent on the server side, so replaying twice is safe.
 */

export async function runOrQueue(
  account: Account,
  op: PendingOp['op'],
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch {
    await queueOp({ accountId: account.id, createdAt: Date.now(), op });
  }
}

let flushing = false;

export async function flushPendingOps(account: Account): Promise<void> {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const ops = await listOps(account.id);
    // Only keep the newest position per episode; older ones are superseded.
    const latestPosition = new Map<number, number>();
    for (const p of ops) {
      if (p.op.kind === 'record_position') {
        latestPosition.set(p.op.episodeId, Math.max(latestPosition.get(p.op.episodeId) ?? 0, p.id!));
      }
    }
    for (const pending of ops) {
      const { op } = pending;
      try {
        switch (op.kind) {
          case 'save_episode':
            await saveEpisode(account, op.episodeId);
            break;
          case 'unsave_episode':
            await unsaveEpisode(account, op.episodeId);
            break;
          case 'mark_completed':
            await markEpisodeCompleted(account, op.episodeId);
            break;
          case 'record_position':
            if (latestPosition.get(op.episodeId) === pending.id) {
              await recordListenDuration(account, op.episodeId, op.seconds);
            }
            break;
        }
        await deleteOp(pending.id!);
      } catch {
        // Still offline or server unhappy — leave the op queued and stop; the
        // next flush will retry from here.
        return;
      }
    }
  } finally {
    flushing = false;
  }
}

/** Wire flush triggers: reconnect and tab focus. Returns a cleanup fn. */
export function installSyncTriggers(getAccount: () => Account | null): () => void {
  const flush = () => {
    const account = getAccount();
    if (account) void flushPendingOps(account);
  };
  window.addEventListener('online', flush);
  window.addEventListener('focus', flush);
  const interval = window.setInterval(flush, 60_000);
  flush();
  return () => {
    window.removeEventListener('online', flush);
    window.removeEventListener('focus', flush);
    window.clearInterval(interval);
  };
}
