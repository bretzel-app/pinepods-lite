import { describe, it, expect } from 'vitest';
import type { Account, DownloadEntry, Episode } from '../lib/types';
import { serverStreamUrl } from '../lib/api';
import type { AdInfo } from '../lib/adSkips';
import type { EngineSnapshot, PlaybackItem } from './engine/types';
import {
  buildPlaybackItems,
  decideStartup,
  downloadsSignature,
  itemChanged,
  playlistWindow,
  resolveSource,
  resumePoint,
} from './resume';

const acct = { id: 'a1', serverUrl: 'https://pods.example.com', apiKey: 'k', userId: 3 } as Account;

function ep(overrides: Partial<Episode> = {}): Episode {
  return {
    episodeid: 1,
    episodetitle: 't',
    podcastname: 'p',
    episodepubdate: '',
    episodedescription: '',
    episodeartwork: '',
    episodeurl: 'http://cdn/default.mp3',
    episodeduration: 0,
    completed: false,
    saved: false,
    queued: false,
    downloaded: false,
    is_youtube: false,
    ...overrides,
  };
}

describe('resolveSource', () => {
  it('prefers a local download', () =>
    expect(resolveSource(acct, ep({ episodeid: 7, downloaded: true }), { filePath: '/x/a1_7' } as DownloadEntry)).toEqual({
      kind: 'download',
      filePath: '/x/a1_7',
    }));
  it('uses the server copy when the server downloaded it', () =>
    expect(resolveSource(acct, ep({ episodeid: 7, downloaded: true }), undefined)).toEqual({
      kind: 'stream',
      url: serverStreamUrl(acct, 7),
      server: true,
    }));
  it('marks the server stream as such', () => {
    expect(resolveSource(acct, ep({ downloaded: true }), undefined)).toMatchObject({ kind: 'stream', server: true });
  });
  it('falls back to the enclosure URL', () =>
    expect(resolveSource(acct, ep({ episodeurl: 'http://cdn/x.mp3' }), undefined)).toEqual({
      kind: 'stream',
      url: 'http://cdn/x.mp3',
    }));
});

describe('resumePoint', () => {
  it('explicit start wins', () => expect(resumePoint(ep({ listenduration: 50 }), 80, 42)).toBe(42));
  it('takes the freshest of local and server', () => expect(resumePoint(ep({ listenduration: 50 }), 80)).toBe(80));
  it('restarts completed episodes', () => expect(resumePoint(ep({ completed: true }), 80)).toBe(0));
  it('restarts within 15 s of the end', () => expect(resumePoint(ep({ episodeduration: 1000 }), 990)).toBe(0));
});

describe('playlistWindow', () => {
  const long = Array.from({ length: 450 }, (_, i) => ep({ episodeid: i }));
  it('keeps one before and 25 after', () =>
    expect(playlistWindow(long, 200)).toEqual({ episodes: long.slice(199, 226), index: 1 }));
  it('clamps at the start', () => expect(playlistWindow(long, 0)).toEqual({ episodes: long.slice(0, 26), index: 0 }));
  it('clamps at the end', () => expect(playlistWindow(long, 449)).toEqual({ episodes: long.slice(448), index: 1 }));
});

describe('buildPlaybackItems', () => {
  const a2 = { id: 'a2', serverUrl: 'https://other.example.com', apiKey: 'k', userId: 4 } as Account;
  const e1 = ep({ episodeid: 1 });
  const e2 = ep({ episodeid: 2 });
  const dl = { filePath: '/x/a2_2' } as DownloadEntry;
  it('builds items for the playback account with sources and start points', () => {
    const items = buildPlaybackItems(a2, [e1, e2], 0, { downloads: new Map([[2, dl]]), localSeconds: new Map([[1, 80]]) }, 42);
    expect(items.map((i) => i.accountId)).toEqual(['a2', 'a2']);
    expect(items[0]).toMatchObject({ key: 'a2:1', startAt: 42 });
    expect(items[1].source).toEqual({ kind: 'download', filePath: dl.filePath });
  });
  it('applies the startAt override to the indexed episode only', () => {
    const ctx = { downloads: new Map<number, DownloadEntry>(), localSeconds: new Map([[1, 80], [2, 90]]) };
    const items = buildPlaybackItems(a2, [e1, e2], 1, ctx, 5);
    expect(items.map((i) => i.startAt)).toEqual([80, 5]);
  });
});

describe('decideStartup', () => {
  const snap = (currentKey: string | null): EngineSnapshot => ({
    currentKey, playing: currentKey != null, position: 0, duration: 0, rate: 1, sleepRemaining: null, sleepMinutes: null,
  });
  const item = (accountId: string): PlaybackItem => ({
    key: `${accountId}:9`, accountId, episode: ep({ episodeid: 9 }), source: { kind: 'stream', url: 'u' }, startAt: 0,
  });
  const last = ep({ episodeid: 7 });
  it('adopts native playback of a known account', () =>
    expect(decideStartup(snap('a1:9'), item('a1'), last, [acct])).toEqual({ kind: 'adopt', item: item('a1'), account: acct }));
  it('restores when the playing account was removed', () =>
    expect(decideStartup(snap('a9:9'), item('a9'), last, [acct])).toEqual({ kind: 'restore', episode: last }));
  it('restores the last played episode when idle', () =>
    expect(decideStartup(snap(null), null, last, [acct])).toEqual({ kind: 'restore', episode: last }));
  it('does nothing without anything to resume', () =>
    expect(decideStartup(snap(null), null, undefined, [acct])).toEqual({ kind: 'none' }));
});

describe('downloadsSignature', () => {
  const dl = (id: number, filePath?: string) =>
    ({ key: `a1:${id}`, accountId: 'a1', episode: ep({ episodeid: id }), filePath, size: id }) as DownloadEntry;

  it('ignores order and fields that do not change the playable source', () =>
    expect(downloadsSignature([dl(1, '/f/1'), dl(2)])).toBe(
      downloadsSignature([{ ...dl(2), size: 99, downloadedAt: 5 }, dl(1, '/f/1')]),
    ));
  it('changes when a download is added or removed', () => {
    expect(downloadsSignature([dl(1)])).not.toBe(downloadsSignature([dl(1), dl(2)]));
    expect(downloadsSignature([dl(1)])).not.toBe(downloadsSignature([]));
  });
  it('changes when a file path changes', () =>
    expect(downloadsSignature([dl(1, '/f/1')])).not.toBe(downloadsSignature([dl(1, '/g/1')])));
});

describe('buildPlaybackItems skips', () => {
  const e = ep({ episodeid: 5, downloaded: true });
  const info = {
    transcript: 'complete',
    segments: [{ kind: 'ad', start: 10, end: 40, status: 'active' }],
    adAudio: { download: 'match', analyzedFingerprint: 'f' },
    fetchedAt: 0,
  } as unknown as AdInfo;
  it('attaches skips for the analyzed server copy', () => {
    const [item] = buildPlaybackItems(acct, [e], 0, {
      downloads: new Map(),
      localSeconds: new Map(),
      adInfo: new Map([[5, info]]),
    });
    expect(item!.skips).toEqual({ uri: serverStreamUrl(acct, 5), ranges: [[10, 40]] });
  });
  it('has none without ad info', () => {
    const [item] = buildPlaybackItems(acct, [e], 0, { downloads: new Map(), localSeconds: new Map() });
    expect(item!.skips).toBeUndefined();
  });
});

describe('itemChanged', () => {
  const server = { kind: 'stream', url: 'https://pods.example.com/api/data/stream/7?x', server: true } as const;
  const item = (o: Partial<PlaybackItem> = {}): PlaybackItem => ({
    key: 'a1:7',
    accountId: 'a1',
    episode: ep({ episodeid: 7 }),
    source: server,
    startAt: 42,
    ...o,
  });
  const skips = { uri: server.url, ranges: [[10, 40]] as [number, number][] };

  it('is false for the same audio and the same ranges, whatever the start point', () => {
    expect(itemChanged(item({ skips }), item({ startAt: 0, skips: { uri: server.url, ranges: [[10, 40]] } }))).toBe(false);
    expect(itemChanged(item(), item())).toBe(false);
  });
  it('is true when ranges arrived, went away or changed', () => {
    expect(itemChanged(item(), item({ skips }))).toBe(true);
    expect(itemChanged(item({ skips }), item())).toBe(true);
    expect(itemChanged(item({ skips }), item({ skips: { ...skips, ranges: [[10, 41]] } }))).toBe(true);
    expect(itemChanged(item({ skips }), item({ skips: { ...skips, ranges: [[10, 40], [90, 120]] } }))).toBe(true);
  });
  it('is true when the audio would come from elsewhere', () => {
    expect(itemChanged(item({ source: { kind: 'stream', url: 'http://cdn/7.mp3' } }), item())).toBe(true);
    expect(itemChanged(item(), item({ source: { kind: 'download', filePath: '/x/a1_7' } }))).toBe(true);
  });
  it('compares only the ranges when the engine cannot name its source (native item after a restart)', () => {
    const adopted = item({ source: { kind: 'stream', url: '' } });
    expect(itemChanged(adopted, item())).toBe(false);
    expect(itemChanged({ ...adopted, skips }, item({ skips }))).toBe(false);
    expect(itemChanged(adopted, item({ skips }))).toBe(true);
  });
});
