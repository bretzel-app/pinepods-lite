import type { Account, Episode } from './types';
import { deleteDownload, getDownload, putDownload } from './db';
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

function setProgress(p: DownloadProgress) {
  inFlight.set(p.episodeId, p);
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

/** Download an episode's audio into IndexedDB. Resolves when playable offline. */
export async function downloadEpisode(account: Account, episode: Episode): Promise<void> {
  const episodeId = episode.episodeid;
  if (inFlight.has(episodeId)) return;
  if (await getDownload(account.id, episodeId)) return;

  setProgress({ episodeId, phase: 'fetching' });
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
    inFlight.delete(episodeId);
    notify();
  }
}

export async function removeDownloadedEpisode(account: Account, episodeId: number): Promise<void> {
  await deleteDownload(account.id, episodeId);
  notify();
}
