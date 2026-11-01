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

/** The user cancelled the download (or it vanished): no error, no server fallback. */
export class DownloadCancelledError extends Error {
  constructor() {
    super('Download cancelled');
    this.name = 'DownloadCancelledError';
  }
}

export interface DownloadBackend {
  /** Fetch `url`, persist it, resolve to the stored entry. `fraction` is undefined when the size is unknown. */
  fetchAndStore(
    url: string,
    pending: PendingDownload,
    onProgress: (fraction?: number) => void,
  ): Promise<DownloadEntry>;
  /** Follow a download already running outside this page (see `running`) until
   * it is stored, as fetchAndStore does after starting one. */
  attach(pending: PendingDownload, onProgress: (fraction?: number) => void): Promise<DownloadEntry>;
  remove(accountId: string, episodeId: number): Promise<void>;
  removeAccount(accountId: string): Promise<void>;
  /** Downloads completed while the UI wasn't running; resolves to how many. */
  recoverFinished(): Promise<number>;
  /** Downloads still running outside this page, e.g. started before the app
   * was restarted, that nothing may be following. */
  running(): Promise<PendingDownload[]>;
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
  // Browser downloads live and die with the page: none run outside it.
  async attach() {
    throw new DownloadCancelledError();
  },
  remove: (accountId, episodeId) => deleteDownload(accountId, episodeId),
  // db.removeAccount already sweeps the blobs.
  async removeAccount() {},
  async recoverFinished() {
    return 0;
  },
  async running() {
    return [];
  },
};

const POLL_MS = 500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll the native download for `pending` until it ends; store it when done. */
async function followNative(pending: PendingDownload, onProgress: (fraction?: number) => void): Promise<DownloadEntry> {
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
    await NativeDownloads.forget({ key: pending.key });
    // The key disappeared (removed in the app or cancelled in the system
    // notification): a user cancel, so no server fallback.
    if (s.state === 'unknown') throw new DownloadCancelledError();
    // failed: let downloadEpisode fall back to the server strategy.
    throw new DownloadFetchError('Download failed');
  }
}

/** Android: DownloadManager writes real files; IndexedDB keeps only the metadata. */
export const nativeDownloadBackend: DownloadBackend = {
  async fetchAndStore(url, pending, onProgress) {
    // Natively, a key whose job is still running is followed, not restarted.
    await NativeDownloads.start({
      key: pending.key,
      url,
      title: pending.episode.episodetitle,
      entry: JSON.stringify(pending),
    });
    return followNative(pending, onProgress);
  },
  attach: followNative,
  async remove(accountId, episodeId) {
    await deleteDownload(accountId, episodeId);
    await NativeDownloads.remove({ key: `${accountId}:${episodeId}` });
  },
  async removeAccount(accountId) {
    await NativeDownloads.removeByPrefix({ prefix: `${accountId}_` });
  },
  async recoverFinished() {
    const { downloads } = await NativeDownloads.finished();
    let recovered = 0;
    for (const d of downloads) {
      // Each entry on its own, so one bad entry can't block the rest.
      let pending: PendingDownload;
      try {
        pending = JSON.parse(d.entry) as PendingDownload;
      } catch {
        await NativeDownloads.forget({ key: d.key }).catch(() => {});
        continue;
      }
      try {
        await putDownloadEntry({
          ...pending,
          filePath: d.filePath,
          mimeType: d.mimeType,
          size: d.size,
          downloadedAt: Date.now(),
        });
        await NativeDownloads.forget({ key: d.key });
        recovered++;
      } catch {
        // Keep the mapping; retried on the next launch.
      }
    }
    return recovered;
  },
  async running() {
    const { downloads } = await NativeDownloads.running();
    return downloads.flatMap((d) => {
      try {
        const p = JSON.parse(d.entry) as Partial<PendingDownload> | null;
        if (typeof p?.accountId === 'string' && typeof p.episode?.episodeid === 'number') {
          return [{ key: d.key, accountId: p.accountId, episode: p.episode }];
        }
      } catch {
        // fall through
      }
      // Unreadable: left alone; once it finishes, recoverFinished drops it.
      return [];
    });
  },
};

export function getDownloadBackend(): DownloadBackend {
  return isNative() ? nativeDownloadBackend : webDownloadBackend;
}
