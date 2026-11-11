import type { Account, Episode } from './types';
import { getDownload, listDownloads } from './db';
import {
  DownloadCancelledError,
  DownloadFetchError,
  getDownloadBackend,
  type DownloadBackend,
  type PendingDownload,
} from './downloadBackend';
import { getEpisodeMetadata, requestServerDownload, serverStreamUrl } from './api';

/**
 * Local (in-browser) episode downloads for true offline playback.
 *
 * Getting the audio bytes is a two-strategy affair:
 *  1. Fetch the enclosure URL directly. Works when the podcast CDN sends CORS
 *     headers (many do), and costs the server nothing.
 *  2. Otherwise ask the PinePods server to download the file server-side, then
 *     pull the bytes from its /api/data/stream endpoint — that one is served
 *     behind the instance's nginx, which sends `Access-Control-Allow-Origin: *`.
 */

export type DownloadPhase = 'fetching' | 'server_downloading' | 'storing';

export interface DownloadProgress {
  episodeId: number;
  phase: DownloadPhase;
  /** 0..1 when the response has a Content-Length, otherwise undefined */
  fraction?: number;
}

type Listener = () => void;

const inFlight = new Map<number, DownloadProgress>();
const listeners = new Set<Listener>();

export function subscribeDownloads(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getDownloadProgress(episodeId: number): DownloadProgress | undefined {
  return inFlight.get(episodeId);
}

function notify() {
  for (const fn of listeners) fn();
}

// Progress events arrive per network chunk — hundreds per second across
// parallel downloads. Every subscriber does IndexedDB reads on notify, so an
// unthrottled stream can saturate the main thread and freeze the UI.
// Only fan out on phase changes, ≥1% progress steps, or every 500ms.
const lastNotified = new Map<number, { phase: DownloadPhase; fraction: number; at: number }>();

function setProgress(p: DownloadProgress) {
  inFlight.set(p.episodeId, p);
  const last = lastNotified.get(p.episodeId);
  const now = Date.now();
  const significant =
    !last ||
    last.phase !== p.phase ||
    (p.fraction ?? 0) - last.fraction >= 0.01 ||
    now - last.at >= 500;
  if (!significant) return;
  lastNotified.set(p.episodeId, { phase: p.phase, fraction: p.fraction ?? 0, at: now });
  notify();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Audio files are buffered in memory while downloading; running many in
// parallel can OOM a mobile tab. Cap concurrency and queue the rest.
const MAX_CONCURRENT_DOWNLOADS = 2;
let activeDownloads = 0;
const downloadQueue: (() => void)[] = [];

async function acquireDownloadSlot(): Promise<void> {
  if (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
    activeDownloads++;
    return;
  }
  await new Promise<void>((resolve) => downloadQueue.push(resolve));
  activeDownloads++;
}

function releaseDownloadSlot() {
  activeDownloads--;
  downloadQueue.shift()?.();
}

/** Download an episode's audio into IndexedDB. Resolves when playable offline. */
export function downloadEpisode(account: Account, episode: Episode): Promise<void> {
  return runDownload(account, episode, (backend, pending, onProgress) =>
    // The server's copy is the one its ad ranges fit; prefer it when it has one.
    episode.downloaded
      ? backend.fetchAndStore(serverStreamUrl(account, episode.episodeid), { ...pending, fromServer: true }, onProgress)
      : backend.fetchAndStore(episode.episodeurl, pending, onProgress),
  );
}

/**
 * Follow native downloads still running without anything polling them —
 * started before the app was restarted, or whose poller stopped — so their
 * progress shows and they are stored when done (or fall back to the server
 * copy if they fail, like a fresh download). Run on launch and on every
 * return to the foreground; downloads already followed are left alone.
 */
export async function resumeDownloads(accounts: Account[]): Promise<void> {
  for (const pending of await getDownloadBackend().running()) {
    const account = accounts.find((a) => a.id === pending.accountId);
    if (!account || inFlight.has(pending.episode.episodeid)) continue;
    void runDownload(account, pending.episode, (backend, _p, onProgress) =>
      // Keep the running download's own fromServer, which runDownload's fresh pending lacks.
      backend.attach(pending, onProgress),
    ).catch(
      (err) => console.warn('Could not finish a download', err),
    );
  }
}

/** One download, `first` getting the bytes from the podcast CDN (strategy 1). */
async function runDownload(
  account: Account,
  episode: Episode,
  first: (backend: DownloadBackend, pending: PendingDownload, onProgress: (fraction?: number) => void) => Promise<unknown>,
): Promise<void> {
  const episodeId = episode.episodeid;
  if (inFlight.has(episodeId)) return;
  if (await getDownload(account.id, episodeId)) return;

  // Mark as queued immediately so the UI shows a spinner while waiting.
  setProgress({ episodeId, phase: 'fetching' });
  await acquireDownloadSlot();
  if (!inFlight.has(episodeId)) {
    // Removed/cancelled while queued.
    releaseDownloadSlot();
    return;
  }
  try {
    const backend = getDownloadBackend();
    const pending = { key: `${account.id}:${episodeId}`, accountId: account.id, episode };
    const progressFor = (phase: DownloadPhase) => (fraction?: number) =>
      setProgress({ episodeId, phase, fraction });

    // Strategy 1: straight from the podcast CDN.
    let stored = true;
    try {
      await first(backend, pending, progressFor('fetching'));
    } catch (e) {
      // Only fetch failures fall back; storage errors (e.g. quota) propagate.
      if (e instanceof DownloadCancelledError) return;
      if (!(e instanceof DownloadFetchError)) throw e;
      stored = false;
    }

    // Strategy 2: server-side download, then stream the bytes from the server.
    if (!stored) {
      setProgress({ episodeId, phase: 'server_downloading' });
      if (!episode.downloaded) {
        await requestServerDownload(account, episodeId);
        // The server downloads in a background task; poll until it reports done.
        const deadline = Date.now() + 5 * 60_000;
        for (;;) {
          await sleep(3000);
          const meta = await getEpisodeMetadata(account, episodeId);
          if (meta.downloaded) break;
          if (Date.now() > deadline) throw new Error('Server download timed out');
        }
      }
      await backend.fetchAndStore(
        serverStreamUrl(account, episodeId),
        { ...pending, fromServer: true },
        progressFor('fetching'),
      );
    }
  } finally {
    releaseDownloadSlot();
    inFlight.delete(episodeId);
    lastNotified.delete(episodeId);
    notify();
  }
}

/** Pick up downloads that finished while the UI wasn't running (native backends). */
export async function recoverDownloads(): Promise<void> {
  if ((await getDownloadBackend().recoverFinished()) > 0) notify();
}

export async function removeDownloadedEpisode(account: Account, episodeId: number): Promise<void> {
  await getDownloadBackend().remove(account.id, episodeId);
  notify();
}

/**
 * Drop local downloads whose episodes are completed according to the server —
 * catches episodes finished on another device. Runs on app start; finishing
 * an episode in this client cleans up immediately via markCompleted instead.
 */
export async function sweepCompletedDownloads(account: Account): Promise<number> {
  if (!navigator.onLine) return 0;
  const entries = await listDownloads(account.id);
  let removed = 0;
  for (const entry of entries) {
    try {
      const meta = await getEpisodeMetadata(account, entry.episode.episodeid);
      if (meta.completed) {
        await getDownloadBackend().remove(account.id, entry.episode.episodeid);
        removed++;
      }
    } catch {
      // Offline or transient server error — keep the download, retry next launch.
    }
  }
  if (removed > 0) notify();
  return removed;
}
