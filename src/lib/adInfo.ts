import { getGeneratedTranscriptStatus, getSkipSegments } from './api';
import { stampDownload, type AdInfo } from './adSkips';
import { cacheGet, cacheSet, getDownload, putDownloadEntry } from './db';
import type { Account, Episode } from './types';

const TIMEOUT_MS = 3000;

export const adInfoKey = (episodeId: number): string => `adinfo:${episodeId}`;

/** Fetch from the server, cache, and stamp the local download if it matches. */
export async function refreshAdInfo(account: Account, episodeId: number): Promise<AdInfo> {
  const { segments, adAudio } = await getSkipSegments(account, episodeId);
  // The transcript endpoint sends the whole transcript; its status only matters before the
  // scan (adStatus doesn't read it after), so a scanned episode keeps what was cached.
  const transcript = segments.some((s) => s.kind === 'ad-scan')
    ? ((await cacheGet<AdInfo>(account.id, adInfoKey(episodeId)))?.transcript ?? null)
    : await getGeneratedTranscriptStatus(account, episodeId);
  const info: AdInfo = { transcript, segments, adAudio, fetchedAt: Date.now() };
  await cacheSet(account.id, adInfoKey(episodeId), info);
  const download = await getDownload(account.id, episodeId);
  const stamped = download && stampDownload(download, info);
  if (stamped) await putDownloadEntry(stamped);
  return info;
}

/** Cached ad info for every episode; the current one is refreshed first when saved and online. */
export async function loadAdInfo(
  account: Account,
  episodes: Episode[],
  current: Episode,
): Promise<Map<number, AdInfo>> {
  const map = new Map<number, AdInfo>();
  await Promise.all(
    episodes.map(async (e) => {
      const cached = await cacheGet<AdInfo>(account.id, adInfoKey(e.episodeid));
      if (cached) map.set(e.episodeid, cached);
    }),
  );
  if (current.saved && navigator.onLine) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fresh = await Promise.race([
        refreshAdInfo(account, current.episodeid),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
        }),
      ]);
      map.set(current.episodeid, fresh);
    } catch {
      // keep the cached value
    } finally {
      clearTimeout(timer);
    }
  }
  return map;
}
