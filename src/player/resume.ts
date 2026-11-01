import type { Account, DownloadEntry, Episode } from '../lib/types';
import { serverStreamUrl } from '../lib/api';
import type { PlaybackSource } from './engine/types';

/** Source priority: local download → server-side copy → enclosure URL. */
export function resolveSource(account: Account, ep: Episode, download: DownloadEntry | undefined): PlaybackSource {
  if (download) return { kind: 'download', filePath: download.filePath };
  if (ep.downloaded) return { kind: 'stream', url: serverStreamUrl(account, ep.episodeid) };
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
