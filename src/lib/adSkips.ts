import type { PlaybackSource, Skips } from '../player/engine/types';
import type { AdAudio, SkipSegment, TranscriptStatus } from './api';
import type { DownloadEntry, Episode } from './types';

export interface AdInfo {
  transcript: TranscriptStatus | null;
  segments: SkipSegment[];
  adAudio: AdAudio | null;
  fetchedAt: number;
}

/** Active and confirmed ads, sorted, overlaps merged. */
export function adRanges(info: AdInfo): [number, number][] {
  const sorted = info.segments
    .filter((s) => s.kind === 'ad' && (s.status === 'active' || s.status === 'confirmed'))
    .map((s): [number, number] => [s.start, s.end])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function isScanned(info: AdInfo): boolean {
  return info.segments.some((s) => s.kind === 'ad-scan');
}

/** The name the engines give a source; ranges are only valid for this uri. */
export function sourceUri(source: PlaybackSource, key: string): string {
  if (source.kind === 'download') return source.filePath ? `file://${source.filePath}` : `idb:${key}`;
  return source.url;
}

export function skipsFor(
  key: string,
  source: PlaybackSource,
  download: DownloadEntry | undefined,
  info: AdInfo | undefined,
): Skips | undefined {
  if (!info) return undefined;
  const analyzed = info.adAudio?.analyzedFingerprint ?? null;
  // An entry not stamped yet counts with the stamp it is about to get (refreshAdInfo writes it
  // without telling anyone), so the first look and first play after a scan already skip.
  const fingerprint = download && (download.adFingerprint ?? stampDownload(download, info)?.adFingerprint);
  const applies =
    source.kind === 'stream'
      ? source.server === true && info.adAudio?.download === 'match'
      : !!download?.fromServer && fingerprint != null && analyzed != null && fingerprint === analyzed;
  if (!applies) return undefined;
  const ranges = adRanges(info);
  return ranges.length ? { uri: sourceUri(source, key), ranges } : undefined;
}

/** The entry stamped with the server's fingerprint, or null when nothing to stamp. */
export function stampDownload(entry: DownloadEntry, info: AdInfo): DownloadEntry | null {
  const fingerprint = info.adAudio?.analyzedFingerprint;
  if (!entry.fromServer || entry.adFingerprint || info.adAudio?.download !== 'match' || !fingerprint) return null;
  return { ...entry, adFingerprint: fingerprint };
}

export type AdStatus =
  | {
      kind:
        | 'downloading'
        | 'waiting'
        | 'transcribing'
        | 'transcription_failed'
        | 'finding_ads'
        | 'no_ads'
        | 'other_copy'
        | 'expired';
    }
  | { kind: 'skipping'; count: number; seconds: number };

export function adStatus(
  key: string,
  episode: Episode,
  info: AdInfo | undefined,
  source: PlaybackSource,
  download: DownloadEntry | undefined,
): AdStatus | null {
  if (!episode.saved || !info) return null;
  if (!isScanned(info)) {
    if (!episode.downloaded) return { kind: 'downloading' };
    if (info.transcript === 'running') return { kind: 'transcribing' };
    if (info.transcript === 'failed') return { kind: 'transcription_failed' };
    if (info.transcript === 'complete') return { kind: 'finding_ads' };
    return { kind: 'waiting' };
  }
  const ranges = adRanges(info);
  if (!ranges.length) return { kind: 'no_ads' };
  if (skipsFor(key, source, download, info)) {
    return { kind: 'skipping', count: ranges.length, seconds: ranges.reduce((t, [s, e]) => t + (e - s), 0) };
  }
  if (info.adAudio?.download !== 'mismatch' && source.kind === 'stream' && !source.server) return { kind: 'expired' };
  return { kind: 'other_copy' };
}

const LABELS: Record<Exclude<AdStatus['kind'], 'skipping'>, [string, string]> = {
  downloading: ['Downloading to server', 'Downloading'],
  waiting: ['Waiting to transcribe', 'Waiting'],
  transcribing: ['Transcribing', 'Transcribing'],
  transcription_failed: ['Transcription failed', 'Failed'],
  finding_ads: ['Finding ads', 'Finding ads'],
  no_ads: ['No ads found', 'No ads'],
  other_copy: ['Ads found on a different copy — delete the download and download it again', 'Other copy'],
  expired: ['Server copy expired — ads play when streaming', 'Expired'],
};

export function adStatusLabel(s: AdStatus, compact: boolean): string {
  if (s.kind === 'skipping') {
    if (compact) return `${s.count} ads skipped`;
    return `${s.count} ads · ${Math.max(1, Math.round(s.seconds / 60))} min skipped`;
  }
  return LABELS[s.kind][compact ? 1 : 0];
}
