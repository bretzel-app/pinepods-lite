import type { DownloadEntry } from './types';
import { deleteDownload, putDownload } from './db';

/**
 * Where downloaded episode bytes end up. The browser keeps them as blobs in
 * IndexedDB; a native (Android) build can save real files instead. Only the
 * "fetch the bytes and store them" and "delete" steps differ — strategy
 * selection, queueing and progress throttling stay in downloads.ts.
 */
export type PendingDownload = Pick<DownloadEntry, 'key' | 'accountId' | 'episode'>;

export interface DownloadBackend {
  /** Fetch `url`, persist it, resolve to the stored entry. `fraction` is undefined when the size is unknown. */
  fetchAndStore(
    url: string,
    pending: PendingDownload,
    onProgress: (fraction?: number) => void,
  ): Promise<DownloadEntry>;
  remove(accountId: string, episodeId: number): Promise<void>;
  removeAccount(accountId: string): Promise<void>;
  /** Downloads completed while the UI wasn't running; resolves to how many. */
  recoverFinished(): Promise<number>;
}

async function fetchWithProgress(url: string, onProgress: (fraction?: number) => void): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length') ?? 0);
  const type = res.headers.get('Content-Type') ?? 'audio/mpeg';
  if (!res.body || !total) {
    onProgress();
    const blob = await res.blob();
    return blob.type ? blob : new Blob([blob], { type });
  }
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received / total);
  }
  return new Blob(chunks, { type });
}

export const webDownloadBackend: DownloadBackend = {
  async fetchAndStore(url, pending, onProgress) {
    const blob = await fetchWithProgress(url, onProgress);
    const entry: DownloadEntry = {
      key: pending.key,
      accountId: pending.accountId,
      episode: pending.episode,
      mimeType: blob.type || 'audio/mpeg',
      size: blob.size,
      downloadedAt: Date.now(),
    };
    await putDownload(entry, blob);
    return entry;
  },
  remove: (accountId, episodeId) => deleteDownload(accountId, episodeId),
  // db.removeAccount already sweeps the blobs.
  async removeAccount() {},
  async recoverFinished() {
    return 0;
  },
};

export function getDownloadBackend(): DownloadBackend {
  return webDownloadBackend;
}
