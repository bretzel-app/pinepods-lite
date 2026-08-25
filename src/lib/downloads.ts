import type { Account, Episode } from './types';
import { deleteDownload, getDownload, listDownloads, putDownload } from './db';
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

async function fetchWithProgress(url: string, episodeId: number, phase: DownloadPhase): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length') ?? 0);
  const type = res.headers.get('Content-Type') ?? 'audio/mpeg';
  if (!res.body || !total) {
    setProgress({ episodeId, phase });
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
    setProgress({ episodeId, phase, fraction: received / total });
  }
  return new Blob(chunks, { type });
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
export async function downloadEpisode(account: Account, episode: Episode): Promise<void> {
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
    let blob: Blob | null = null;

    // Strategy 1: straight from the podcast CDN.
    try {
      blob = await fetchWithProgress(episode.episodeurl, episodeId, 'fetching');
    } catch {
      blob = null;
    }

    // Strategy 2: server-side download, then stream the bytes from the server.
    if (!blob) {
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
      blob = await fetchWithProgress(serverStreamUrl(account, episodeId), episodeId, 'fetching');
    }

    setProgress({ episodeId, phase: 'storing' });
    await putDownload(
      {
        key: `${account.id}:${episodeId}`,
        accountId: account.id,
        episode,
        mimeType: blob.type || 'audio/mpeg',
        size: blob.size,
        downloadedAt: Date.now(),
      },
      blob,
    );
  } finally {
    releaseDownloadSlot();
    inFlight.delete(episodeId);
    lastNotified.delete(episodeId);
    notify();
  }
}

export async function removeDownloadedEpisode(account: Account, episodeId: number): Promise<void> {
  await deleteDownload(account.id, episodeId);
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
        await deleteDownload(account.id, entry.episode.episodeid);
        removed++;
      }
    } catch {
      // Offline or transient server error — keep the download, retry next launch.
    }
  }
  if (removed > 0) notify();
  return removed;
}
