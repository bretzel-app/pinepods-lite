import type { DownloadEntry } from './types';
import { deleteDownload, putDownload, putDownloadEntry } from './db';
import { NativeDownloads, isNative } from '../native/plugins';

/**
 * Where downloaded episode bytes end up. The browser keeps them as blobs in
 * IndexedDB; a native (Android) build can save real files instead. Only the
 * "fetch the bytes and store them" and "delete" steps differ — strategy
 * selection, queueing and progress throttling stay in downloads.ts.
 */
export type PendingDownload = Pick<DownloadEntry, 'key' | 'accountId' | 'episode'>;

/**
 * Thrown by a backend when getting the bytes failed (network, HTTP status,
 * broken transfer). Storage errors are NOT wrapped: they propagate as-is, so
 * downloadEpisode only falls back to the server strategy for fetch failures.
 */
export class DownloadFetchError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DownloadFetchError';
    this.cause = cause;
  }
}

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
    let blob: Blob;
    try {
      blob = await fetchWithProgress(url, onProgress);
    } catch (e) {
      throw new DownloadFetchError(e instanceof Error ? e.message : String(e), e);
    }
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

const POLL_MS = 500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Android: DownloadManager writes real files; IndexedDB keeps only the metadata. */
export const nativeDownloadBackend: DownloadBackend = {
  async fetchAndStore(url, pending, onProgress) {
    await NativeDownloads.start({
      key: pending.key,
      url,
      title: pending.episode.episodetitle,
      entry: JSON.stringify(pending),
    });
    for (;;) {
      await sleep(POLL_MS);
      const s = await NativeDownloads.status({ key: pending.key });
      if (s.state === 'running') {
        onProgress(s.fraction);
        continue;
      }
      if (s.state === 'done') {
        const entry: DownloadEntry = {
          ...pending,
          filePath: s.filePath,
          mimeType: s.mimeType || 'audio/mpeg',
          size: s.size ?? 0,
          downloadedAt: Date.now(),
        };
        await putDownloadEntry(entry);
        await NativeDownloads.forget({ key: pending.key });
        return entry;
      }
      // failed or unknown: let downloadEpisode fall back to the server strategy.
      await NativeDownloads.forget({ key: pending.key });
      throw new DownloadFetchError('Download failed');
    }
  },
  async remove(accountId, episodeId) {
    await deleteDownload(accountId, episodeId);
    await NativeDownloads.remove({ key: `${accountId}:${episodeId}` });
  },
  async removeAccount(accountId) {
    await NativeDownloads.removeByPrefix({ prefix: `${accountId}_` });
  },
  async recoverFinished() {
    const { downloads } = await NativeDownloads.finished();
    for (const d of downloads) {
      const pending = JSON.parse(d.entry) as PendingDownload;
      await putDownloadEntry({
        ...pending,
        filePath: d.filePath,
        mimeType: d.mimeType,
        size: d.size,
        downloadedAt: Date.now(),
      });
      await NativeDownloads.forget({ key: d.key });
    }
    return downloads.length;
  },
};

export function getDownloadBackend(): DownloadBackend {
  return isNative() ? nativeDownloadBackend : webDownloadBackend;
}
