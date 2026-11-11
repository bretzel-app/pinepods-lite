import type { Account, DownloadEntry, Episode } from '../lib/types';
import { serverStreamUrl } from '../lib/api';
import { skipsFor, sourceUri, type AdInfo } from '../lib/adSkips';
import type { EngineSnapshot, PlaybackItem, PlaybackSource, Skips } from './engine/types';

/** Source priority: local download → server-side copy → enclosure URL. */
export function resolveSource(account: Account, ep: Episode, download: DownloadEntry | undefined): PlaybackSource {
  if (download) return { kind: 'download', filePath: download.filePath };
  if (ep.downloaded) return { kind: 'stream', url: serverStreamUrl(account, ep.episodeid), server: true };
  return { kind: 'stream', url: ep.episodeurl };
}

/** Resume point: an explicit start (e.g. tapped transcript line) wins, else
 * the freshest of local (offline-safe) and server-known position. */
export function resumePoint(ep: Episode, localSeconds: number | undefined, startAt?: number): number {
  if (startAt != null) return startAt;
  const serverSeconds = ep.listenduration ?? 0;
  const resumeAt = Math.max(localSeconds ?? 0, serverSeconds);
  const total = ep.episodeduration || 0;
  if (ep.completed || (total > 0 && resumeAt > total - 15)) return 0;
  return resumeAt;
}

/** The slice of a list handed to the engine: a little history, a long tail. */
export function playlistWindow(
  list: Episode[],
  currentId: number,
  before = 1,
  after = 25,
): { episodes: Episode[]; index: number } {
  const at = Math.max(0, list.findIndex((e) => e.episodeid === currentId));
  const start = Math.max(0, at - before);
  return { episodes: list.slice(start, at + after + 1), index: at - start };
}

/** Engine items for `episodes`; `startAt` overrides only `episodes[index]`. */
export function buildPlaybackItems(
  account: Account,
  episodes: Episode[],
  index: number,
  ctx: { downloads: Map<number, DownloadEntry>; localSeconds: Map<number, number>; adInfo?: Map<number, AdInfo> },
  startAt?: number,
): PlaybackItem[] {
  return episodes.map((episode, i) => {
    const key = `${account.id}:${episode.episodeid}`;
    const download = ctx.downloads.get(episode.episodeid);
    const source = resolveSource(account, episode, download);
    const skips = skipsFor(key, source, download, ctx.adInfo?.get(episode.episodeid));
    return {
      key,
      accountId: account.id,
      episode,
      source,
      startAt: resumePoint(episode, ctx.localSeconds.get(episode.episodeid), i === index ? startAt : undefined),
      ...(skips ? { skips } : {}),
    };
  });
}

function sameSkips(a: Skips | undefined, b: Skips | undefined): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.uri === b.uri &&
    a.ranges.length === b.ranges.length &&
    a.ranges.every(([start, end], i) => start === b.ranges[i][0] && end === b.ranges[i][1])
  );
}

/** Whether `rebuilt` would play differently from the engine's `current` item: other audio or
 * other ad ranges. A source the engine can't name (a native item adopted after a restart has
 * an empty url) only has its ranges compared. */
export function itemChanged(current: PlaybackItem, rebuilt: PlaybackItem): boolean {
  const uri = sourceUri(current.source, current.key);
  if (uri !== '' && uri !== sourceUri(rebuilt.source, rebuilt.key)) return true;
  return !sameSkips(current.skips, rebuilt.skips);
}

/** What of the downloads decides playable sources: which episodes have one,
 * and where its file is. Progress or other metadata leave it unchanged. */
export function downloadsSignature(downloads: DownloadEntry[]): string {
  return downloads
    .map((d) => `${d.key}=${d.filePath ?? ''}`)
    .sort()
    .join('\n');
}

/** On launch: adopt what the engine is already playing, else restore the last episode. */
export function decideStartup(
  snap: EngineSnapshot,
  current: PlaybackItem | null,
  lastPlayed: Episode | undefined,
  accounts: Account[],
): { kind: 'adopt'; item: PlaybackItem; account: Account } | { kind: 'restore'; episode: Episode } | { kind: 'none' } {
  if (snap.currentKey != null && current) {
    const account = accounts.find((a) => a.id === current.accountId);
    if (account) return { kind: 'adopt', item: current, account };
  }
  return lastPlayed ? { kind: 'restore', episode: lastPlayed } : { kind: 'none' };
}
