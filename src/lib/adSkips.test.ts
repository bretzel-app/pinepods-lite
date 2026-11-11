import { describe, expect, it } from 'vitest';
import type { DownloadEntry, Episode } from './types';
import { adRanges, adStatus, adStatusLabel, isScanned, skipsFor, sourceUri, stampDownload, type AdInfo } from './adSkips';
import type { AdAudio, SkipSegment, TranscriptStatus } from './api';

const seg = (kind: string, start: number, end: number, status: string | null): SkipSegment => ({ kind, start, end, status });
const info = (segments: SkipSegment[], adAudio: AdAudio | null = null, transcript: TranscriptStatus | null = null): AdInfo => ({
  transcript,
  segments,
  adAudio,
  fetchedAt: 0,
});
const dl = (o: Partial<DownloadEntry>) => o as DownloadEntry;
const episode = (o: Partial<Episode>) => o as Episode;

const server = { kind: 'stream', url: 'https://pp/api/data/stream/7?x', server: true } as const;
const publisher = { kind: 'stream', url: 'https://cdn/7.mp3' } as const;

describe('adRanges', () => {
  it('keeps active and confirmed ads, sorted and merged', () => {
    expect(
      adRanges(
        info([
          seg('ad', 90, 120, 'confirmed'),
          seg('ad', 10, 40, 'active'),
          seg('ad', 35, 50, 'active'),
          seg('ad', 200, 230, 'rejected'),
          seg('ad', 300, 330, 'pending'),
          seg('silence', 60, 62, null),
          seg('ad-scan', 0, 0, null),
        ]),
      ),
    ).toEqual([[10, 50], [90, 120]]);
  });
  it('sees the scan marker', () => {
    expect(isScanned(info([seg('ad-scan', 0, 0, null)]))).toBe(true);
    expect(isScanned(info([]))).toBe(false);
  });
});

describe('skipsFor', () => {
  it('skips on the server stream only when the copy matches', () => {
    const i = info([seg('ad', 10, 40, 'active')], { analyzedFingerprint: 'f', download: 'match' });
    expect(skipsFor('a:7', server, undefined, i)).toEqual({ uri: server.url, ranges: [[10, 40]] });
    expect(skipsFor('a:7', server, undefined, { ...i, adAudio: { analyzedFingerprint: 'f', download: 'mismatch' } })).toBeUndefined();
    expect(skipsFor('a:7', publisher, undefined, i)).toBeUndefined();
  });
  it('is undefined without ranges', () => {
    const i = info([seg('ad-scan', 0, 0, null)], { analyzedFingerprint: 'f', download: 'match' });
    expect(skipsFor('a:7', server, undefined, i)).toBeUndefined();
    expect(skipsFor('a:7', server, undefined, undefined)).toBeUndefined();
  });
  it('skips a phone download only when it is stamped with the analyzed copy', () => {
    const src = { kind: 'download', filePath: '/d/a_7' } as const;
    const i = info([seg('ad', 10, 40, 'active')], { analyzedFingerprint: 'f', download: 'none' });
    expect(skipsFor('a:7', src, dl({ fromServer: true, adFingerprint: 'f' }), i)).toEqual({ uri: 'file:///d/a_7', ranges: [[10, 40]] });
    expect(skipsFor('a:7', src, dl({ fromServer: true, adFingerprint: 'old' }), i)).toBeUndefined();
    expect(skipsFor('a:7', src, dl({}), i)).toBeUndefined();
    expect(skipsFor('a:7', src, undefined, i)).toBeUndefined();
  });
  it('never matches two null fingerprints', () => {
    const src = { kind: 'download', filePath: '/d/a_7' } as const;
    const i = info([seg('ad', 10, 40, 'active')], { analyzedFingerprint: null, download: 'none' });
    expect(skipsFor('a:7', src, dl({ fromServer: true }), i)).toBeUndefined();
  });
});

describe('sourceUri', () => {
  it('names sources the same way the engines do', () => {
    expect(sourceUri({ kind: 'download', filePath: '/d/a_7' }, 'a:7')).toBe('file:///d/a_7');
    expect(sourceUri({ kind: 'download' }, 'a:7')).toBe('idb:a:7');
    expect(sourceUri(publisher, 'a:7')).toBe('https://cdn/7.mp3');
  });
});

describe('stampDownload', () => {
  it('stamps a server-copy download once the server reports a match', () => {
    const i = info([], { analyzedFingerprint: 'f', download: 'match' });
    expect(stampDownload(dl({ fromServer: true }), i)?.adFingerprint).toBe('f');
    expect(stampDownload(dl({ fromServer: true, adFingerprint: 'old' }), i)).toBeNull();
    expect(stampDownload(dl({}), i)).toBeNull();
    expect(stampDownload(dl({ fromServer: true }), info([], { analyzedFingerprint: 'f', download: 'mismatch' }))).toBeNull();
  });
});

describe('adStatus', () => {
  it.each([
    ['not starred', { saved: false }, info([]), server, undefined, null],
    ['no server copy yet', { saved: true, downloaded: false }, info([]), publisher, undefined, 'downloading'],
    ['no transcript', { saved: true, downloaded: true }, info([], null, null), server, undefined, 'waiting'],
    ['running', { saved: true, downloaded: true }, info([], null, 'running'), server, undefined, 'transcribing'],
    ['failed', { saved: true, downloaded: true }, info([], null, 'failed'), server, undefined, 'transcription_failed'],
    ['complete, not scanned', { saved: true, downloaded: true }, info([], null, 'complete'), server, undefined, 'finding_ads'],
    ['scanned, no ads', { saved: true, downloaded: true }, info([seg('ad-scan', 0, 0, null)]), server, undefined, 'no_ads'],
    ['expired', { saved: true, downloaded: false }, info([seg('ad-scan', 0, 0, null), seg('ad', 10, 40, 'active')], { analyzedFingerprint: 'f', download: 'none' }), publisher, undefined, 'expired'],
    ['other copy', { saved: true, downloaded: true }, info([seg('ad-scan', 0, 0, null), seg('ad', 10, 40, 'active')], { analyzedFingerprint: 'f', download: 'mismatch' }), server, undefined, 'other_copy'],
  ] as const)('status: %s', (_, e, i, src, d, kind) => {
    expect(adStatus('a:7', episode(e), i, src, d)?.kind ?? null).toBe(kind);
  });
  it('is null without info', () => {
    expect(adStatus('a:7', episode({ saved: true }), undefined, server, undefined)).toBeNull();
  });
  it('counts skipped ads and time', () => {
    const i = info([seg('ad-scan', 0, 0, null), seg('ad', 10, 40, 'active'), seg('ad', 100, 730, 'active')], { analyzedFingerprint: 'f', download: 'match' });
    expect(adStatus('a:7', episode({ saved: true, downloaded: true }), i, server, undefined)).toEqual({ kind: 'skipping', count: 2, seconds: 660 });
  });
});

describe('adStatusLabel', () => {
  it('labels', () => {
    expect(adStatusLabel({ kind: 'skipping', count: 7, seconds: 660 }, false)).toBe('7 ads · 11 min skipped');
    expect(adStatusLabel({ kind: 'skipping', count: 7, seconds: 660 }, true)).toBe('7 ads skipped');
    expect(adStatusLabel({ kind: 'skipping', count: 1, seconds: 10 }, false)).toBe('1 ads · 1 min skipped');
    expect(adStatusLabel({ kind: 'expired' }, false)).toBe('Server copy expired — ads play when streaming');
    expect(adStatusLabel({ kind: 'expired' }, true)).toBe('Expired');
    expect(adStatusLabel({ kind: 'other_copy' }, false)).toBe('Ads found on a different copy — delete the download and download it again');
    expect(adStatusLabel({ kind: 'downloading' }, false)).toBe('Downloading to server');
    expect(adStatusLabel({ kind: 'no_ads' }, true)).toBe('No ads');
  });
});
